# positron-remote

Воспроизводимые рабочие окружения для проектов: Docker-образы с R, пакетами и Positron, которые
запускаются **на stats2, на любом другом сервере или на своём компьютере** — без привязки к stats2.
Тот же образ окружения используют CI (сборка отчётов с данными) и агенты (без доступа к данным).
Обсуждение и мотивация: [meeting-summary.md](meeting-summary.md).

## Устройство

Три слоя:

```
┌───────────────────────────────────────────────┐
│ 3. Positron   ghcr.io/<owner>/positron:<…>    │  для людей: positron-reh + sshd-entrypoint
├───────────────────────────────────────────────┤  (build-image.sh, только ADD — собирается где угодно)
│ 2. Проект     ghcr.io/<owner>/<проект>-env    │  необязательно: свои пакеты проекта
├───────────────────────────────────────────────┤  (Dockerfile в репозитории проекта)
│ 1. Окружение  ghcr.io/<owner>/r-env:<тег>     │  R и пакеты из renv.lock, quarto,
└───────────────────────────────────────────────┘  git, git-crypt, sshd, пользователь analyst (env/)
```

- **Образ окружения** собирается в GitHub Actions и получает тег `<дата>-<commit>`. Старые теги не меняются.
- **Проект фиксирует свой образ** в файле `container.env` в корне репозитория:
  `ENV_IMAGE=ghcr.io/<owner>/r-env:2026.11.16-abc1234`. Обновить окружение = сменить тег отдельным коммитом.
- **Контейнер на каждый проект**: `positron-<проект>`, с собственными томами для работы и данных Positron.
  Проекты не мешают друг другу, старые сессии убираются вместе с контейнером.
- **Исходники всегда из git.** Проекты живут только в Gitea (на GitHub — только образы и этот репозиторий).
  Gitea стоит не на stats2, поэтому при падении stats2 проект клонируется в локальный контейнер как обычно.
  Между хостами работа переезжает только через git: перед переездом нужно сделать push.

`run-positron.sh <проект>`:

1. читает `container.env` из репозитория проекта (последняя копия кешируется на случай, если git недоступен);
2. выбирает хост: первый доступный из `HOSTS` (например, stats2, затем local) или заданный `--host`;
3. берёт образ `positron:<имя env>-<тег env>-<версия клиента>`: из реестра, с другого хоста или собирает на месте;
4. запускает контейнер, порт SSH открыт только на `127.0.0.1` хоста; к удалённому хосту подключение идёт
   через `ProxyJump`;
5. пишет `~/.ssh/positron/<проект>.conf` с хостом `positron-<проект>` для Positron Remote SSH;
6. по SSH с пробросом ssh-agent клонирует или обновляет проект в `~/<проект>`. Git ходит в Gitea
   с вашими ключами, токены нигде не хранятся.

## Первичная настройка

1. **GitHub.** Запушить этот репозиторий на GitHub, запустить workflow *env image* (Actions → env image →
   Run workflow; push с изменениями в `env/` запускает его сам). В summary будет тег образа. Записать его
   в repository variable `DEFAULT_ENV_IMAGE` (Settings → Variables) — нужно для еженедельной сборки слоя Positron.
   После первой сборки сделать пакет `r-env` публичным (организация → Packages → r-env → Package settings →
   Change visibility → Public): в образе нет данных и секретов, а публичные пакеты бесплатны и скачиваются
   без входа в реестр. Новые теги сохраняют эту настройку.
2. **Docker на Mac**: `brew install docker` (CLI) и OrbStack или Docker Desktop, если нужен локальный запуск.
   Образы `linux/amd64` работают на Apple Silicon через Rosetta (в Docker Desktop: Settings → General →
   *Use Rosetta for x86/amd64 emulation*).
3. **Доступ к реестру**: публичный `r-env` скачивается без входа. Вход нужен только чтобы пушить с этой
   машины или скачивать приватные образы проектов:
   `gh auth refresh -s write:packages && gh auth token | docker login ghcr.io -u <github-user> --password-stdin`.
   Образы Positron (`ghcr.io/<owner>/positron`) приватные: в них сервер Positron от Posit (Elastic License 2.0).
   Без входа в реестр `run-positron.sh` просто соберёт этот слой на хосте сам (несколько минут).
   Серверы без доступа к ghcr.io перечислите в `NO_REGISTRY_HOSTS`: для них образ скачивается на Mac
   и переносится по SSH.
4. **Конфиг**: `cp positron.env.example positron.env` и заполнить `REGISTRY`, `DEFAULT_ENV_IMAGE`, `HOSTS`,
   `GIT_REMOTES`.
5. **SSH**: в самое начало `~/.ssh/config` добавить строку `Include positron/*.conf`. Ключ, которым вы ходите
   в Gitea, должен быть в ssh-agent (`ssh-add -l`; на macOS `ssh-add --apple-use-keychain`).

Чтобы перенести текущую среду stats2 в `env/`:

```bash
./inspect-container.sh --host stats2                       # контейнеры на stats2
./inspect-container.sh --host stats2 <контейнер>           # образ, тома, ОС, есть ли quarto/git-crypt
./inspect-container.sh --host stats2 <контейнер> --r-packages   # версия R и пакеты: сверить с env/renv.lock
```

## Работа

```bash
./run-positron.sh thesis                 # stats2, если доступен, иначе локально
./run-positron.sh thesis --host local    # принудительно на Mac
./run-positron.sh thesis --unlock        # плюс git-crypt unlock ключом GIT_CRYPT_KEY_FILE
./run-positron.sh thesis --stop          # остановить (тома остаются)
./run-positron.sh --list                 # контейнеры проектов на всех хостах
```

Дальше в Positron: Remote SSH → `positron-thesis`, папка `/home/analyst/thesis`.

- После обновления Positron на Mac достаточно снова выполнить `./run-positron.sh <проект>`: контейнер
  пересоздастся с новой версией сервера, тома с работой и расширениями сохранятся.
- В контейнере `positron-projects status` показывает незакоммиченное и неотправленное, а `positron-projects sync`
  подтягивает свежие изменения. Скрипт не перезаписывает существующую работу: при незакоммиченных изменениях
  или расхождении с origin он делает только `fetch`.
- R-пакеты, установленные вручную внутри контейнера, при пересоздании пропадут. Это сделано намеренно:
  постоянный пакет добавляется в `env/renv.lock` (для всех) или в Dockerfile проекта.

## Проект со своими пакетами

Если проекту не хватает пакетов из `r-env`, скопируйте в репозиторий проекта файлы из
[project-template/](project-template/):

- `Dockerfile`: `FROM ghcr.io/<owner>/r-env:<тег>` и установка нужных пакетов;
- `project-env.yml` → `.github/workflows/env.yml`: вызывает переиспользуемый workflow
  [project-env.yml](.github/workflows/project-env.yml) и публикует `ghcr.io/<owner>/<проект>-env:<тег>`.
  Если этот репозиторий приватный, разрешите доступ к его workflow: Settings → Actions → General → Access;
- `container.env`: после сборки запишите в `ENV_IMAGE` тег из summary.

## Обновление общего окружения

Пакеты и их версии задаёт [env/renv.lock](env/renv.lock). Чтобы обновить окружение:

1. заменить `env/renv.lock` новым курируемым lock-файлом;
2. в [env/Dockerfile](env/Dockerfile) выставить `R_VERSION` равным версии R из lock-файла, а `CRAN_SNAPSHOT` —
   дате, которую выведет `env/snapshot-date.sh` (на эту дату все версии из lock-файла есть в Posit Package Manager
   бинарными, и сборка идёт минуты, а не часы);
3. push в `main` соберёт новый тег. Проекты переходят на него по одному — сменой `ENV_IMAGE` в `container.env`.

При сборке образ проверяет, что установленные версии совпадают с lock-файлом, и падает, если нет.

## Агенты и CI (следующий шаг)

Образ окружения уже содержит всё нужное. Слой Positron для этого не нужен:

- **агент**: `docker run --rm ghcr.io/<owner>/r-env:<тег> ...` с клоном репозитория, где данные остаются
  зашифрованы git-crypt; агент пишет qmd/Rmd и открывает PR;
- **CI в PR**: тот же образ, `git-crypt unlock` ключом из секрета, `quarto render`, ссылка на HTML в Telegram.

## Проверки перед коммитом

`./lint.sh` проверяет shell-скрипты (синтаксис и shellcheck), workflows GitHub Actions (actionlint, включая
shellcheck их `run:`) и Dockerfile (hadolint). Те же проверки запускаются в CI на каждый push и pull request
([lint.yml](.github/workflows/lint.yml)).

Один раз после клонирования включите запуск перед каждым коммитом:

```bash
brew install shellcheck actionlint hadolint   # необязательно: без них lint.sh запустит их из Docker
./lint.sh --install-hook
```

Пропустить проверку разово: `git commit --no-verify` (CI всё равно проверит). Настройки линтеров:
[.shellcheckrc](.shellcheckrc), [.hadolint.yaml](.hadolint.yaml) — там же объяснено, что и почему отключено.

## Файлы

- [env/](env/): образ окружения `r-env` (Dockerfile, renv.lock, подбор даты снимка)
- [positron/](positron/): слой Positron (Dockerfile, `positron-entrypoint`, `positron-projects`)
- [project-template/](project-template/): `container.env`, Dockerfile и workflow для репозитория проекта
- [.github/workflows/](.github/workflows/): сборка `r-env`, слоя Positron, образов проектов
- [run-positron.sh](run-positron.sh): запуск контейнера проекта на любом хосте
- [build-image.sh](build-image.sh): сборка слоя Positron (вызывается из run-positron.sh и CI)
- [inspect-container.sh](inspect-container.sh): параметры существующих контейнеров, список R-пакетов
- [lint.sh](lint.sh), [.githooks/](.githooks/): проверки перед коммитом
- [lib.sh](lib.sh): общие функции и конфиг; [positron.env.example](positron.env.example): шаблон конфига

Скачанные архивы Positron кешируются в `.cache/downloads/` (около 530 МБ каждый, старые можно удалять).
