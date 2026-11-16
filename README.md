# positron-remote

Воспроизводимые рабочие окружения для проектов: Docker-образ с R и пакетами, в котором проект открывается
одинаково **на своём компьютере или на любом сервере**, без привязки к конкретной машине.
Тот же образ окружения используют CI (сборка отчётов с данными) и агенты (без доступа к данным).
Обсуждение и мотивация: [meeting-summary.md](meeting-summary.md).

## Как с этим работать

Есть два способа открыть проект в контейнере:

1. **Dev Containers в Positron** — основной способ, без терминала. В шаблоне проекта лежит
   `.devcontainer/devcontainer.json`; Positron сам предлагает *Reopen in Container*, запускает контейнер
   и подключается к нему. Пошагово: [docs/new-project.md](docs/new-project.md).
2. **`run-positron.sh`** — для запуска на сервере (Dev Containers не работают поверх Remote SSH) или без
   локальной копии проекта. Скрипт поднимает контейнер на любом Docker-хосте из `HOSTS`, а Positron
   подключается к нему по Remote SSH. Подробнее — ниже, в разделе [run-positron.sh](#run-positronsh).

В обоих случаях проект фиксирует своё окружение в одном месте — строке `"image"` в
`.devcontainer/devcontainer.json`:

```json
{
  "name": "R (fnkc-stats r-env)",
  "image": "ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7",
  "remoteUser": "analyst"
}
```

Обновить окружение проекта = сменить тег отдельным коммитом. Шаблон: [project-template/](project-template/).

## Устройство

```
┌───────────────────────────────────────────────┐
│ Positron      ghcr.io/<owner>/positron:<…>    │  только для run-positron.sh: positron-reh + sshd
├───────────────────────────────────────────────┤  (build-image.sh, только ADD — собирается где угодно)
│ Проект        .devcontainer/Dockerfile        │  необязательно: свои пакеты проекта,
├───────────────────────────────────────────────┤  собирается локально при открытии
│ Окружение     ghcr.io/<owner>/r-env:<тег>     │  R и пакеты из renv.lock, quarto,
└───────────────────────────────────────────────┘  git, git-crypt, sshd, пользователь analyst (env/)
```

- **Образ окружения** собирается в GitHub Actions и получает тег `<дата>-<commit>`. Старые теги не меняются.
  Пакет `r-env` публичный: в нём нет данных и секретов, и он скачивается без входа в реестр.
- **Исходники всегда из git.** Проекты живут только в Gitea; на GitHub — только образы и этот репозиторий.
  Между машинами работа переезжает только через git: перед переездом нужно сделать push.
- **Данные** лежат в репозиториях проектов зашифрованными (git-crypt). Ключ есть только у людей, не в образах.
- В режиме Dev Containers папка проекта — это обычная папка на вашем компьютере, смонтированная в контейнер;
  Positron сам ставит в контейнер свою серверную часть.

## Настройка рабочего места (для всех)

1. **Docker-приложение.** Подойдёт Docker Desktop, Podman Desktop или Rancher Desktop (обычные установщики).
   Docker Desktop бесплатен только для организаций до 250 сотрудников и $10 млн выручки; Podman Desktop
   и Rancher Desktop бесплатны всегда. На Apple Silicon включите эмуляцию amd64 через Rosetta (в Docker Desktop:
   Settings → General → *Use Rosetta for x86/amd64 emulation*).
2. **Positron:** в настройках включить `dev.containers.enable` (функция пока в статусе preview).
   Если Docker работает не через `/var/run/docker.sock` (например, Colima: `~/.colima/default/docker.sock`),
   указать путь в настройке `dev.containers.dockerSocketPath`.
3. **SSH-ключ в Gitea** (Settings → SSH / GPG Keys). SSH у нашей Gitea работает на порту 2221.

Дальше — [docs/new-project.md](docs/new-project.md). Простая инструкция для коллег без технических
подробностей: [docs/kak-rabotat.md](docs/kak-rabotat.md).

## run-positron.sh

Для запуска на сервере или без локальной копии проекта. Нужны Docker CLI, `git`, `jq`, `curl`.

```bash
cp positron.env.example positron.env      # заполнить HOSTS, GIT_REMOTES, DEFAULT_ENV_IMAGE
./run-positron.sh thesis                  # первый доступный хост из HOSTS
./run-positron.sh thesis --host local     # на этом компьютере
./run-positron.sh thesis --unlock         # плюс git-crypt unlock ключом GIT_CRYPT_KEY_FILE
./run-positron.sh thesis --stop           # остановить (тома остаются)
./run-positron.sh --list                  # контейнеры проектов на всех хостах
```

Один раз: в самое начало `~/.ssh/config` добавить строку `Include positron/*.conf`, а ключ для Gitea держать
в ssh-agent (`ssh-add -l`; на macOS `ssh-add --apple-use-keychain`).

Что делает `run-positron.sh <проект>`:

1. читает `.devcontainer/devcontainer.json` из репозитория проекта (последняя копия кешируется на случай,
   если git недоступен); без него берёт `DEFAULT_ENV_IMAGE`;
2. выбирает хост: первый доступный из `HOSTS` (например, `server`, затем `local`) или заданный `--host`;
3. берёт образ `positron:<имя env>-<тег env>-<версия клиента>`: из реестра, с другого хоста или собирает на месте.
   Образы Positron приватные (в них сервер Positron от Posit, Elastic License 2.0); без входа в реестр слой
   просто соберётся на хосте за несколько минут;
4. запускает контейнер `positron-<проект>`; порт SSH открыт только на `127.0.0.1` хоста, к удалённому хосту
   подключение идёт через `ProxyJump`;
5. пишет `~/.ssh/positron/<проект>.conf` с хостом `positron-<проект>` для Positron Remote SSH;
6. по SSH с пробросом ssh-agent клонирует или обновляет проект в `~/<проект>` (отдельный том, переживает
   пересоздание контейнера). Git ходит в Gitea с вашими ключами, токены нигде не хранятся.

Дальше в Positron: Remote SSH → `positron-thesis`, папка `/home/analyst/thesis`.

- После обновления Positron достаточно снова выполнить `./run-positron.sh <проект>`: контейнер пересоздастся
  с новой версией сервера, проект и расширения сохранятся.
- В контейнере `positron-projects status` показывает незакоммиченное и неотправленное, а `positron-projects sync`
  подтягивает свежие изменения, не трогая существующую работу.
- Проекты со своим Dockerfile (`"build"` в devcontainer.json) пока открываются только через Dev Containers.

Серверы без доступа к ghcr.io перечислите в `NO_REGISTRY_HOSTS`: образ для них скачивается на этой машине
и переносится по SSH. Чтобы перенести существующую рабочую среду в `env/`:

```bash
./inspect-container.sh --host server                        # контейнеры на хосте
./inspect-container.sh --host server <контейнер>            # образ, тома, ОС, есть ли quarto/git-crypt
./inspect-container.sh --host server <контейнер> --r-packages   # версия R и пакеты: сверить с env/renv.lock
```

## Проект со своими пакетами

Если проекту не хватает пакетов из `r-env`, в его `.devcontainer/` добавляется Dockerfile
(пример: [project-template/.devcontainer/Dockerfile.example](project-template/.devcontainer/Dockerfile.example)):
«взять `r-env:<тег>` и доставить пакеты X, Y». В `devcontainer.json` строка `"image"` заменяется на
`"build": { "dockerfile": "Dockerfile" }`, и Positron соберёт образ проекта на вашем компьютере при открытии.
Версии пакетов берутся из того же датированного снимка CRAN, что и `r-env`. Если пакет нужен многим проектам,
лучше добавить его в общий `env/renv.lock`.

## Обновление общего окружения

Пакеты и их версии задаёт [env/renv.lock](env/renv.lock). Чтобы обновить окружение:

1. заменить `env/renv.lock` новым курируемым lock-файлом;
2. в [env/Dockerfile](env/Dockerfile) выставить `R_VERSION` равным версии R из lock-файла, а `CRAN_SNAPSHOT` —
   дате, которую выведет `env/snapshot-date.sh` (на эту дату все версии из lock-файла есть в Posit Package Manager
   бинарными, и сборка идёт минуты, а не часы);
3. push в `main` соберёт новый тег. Проекты переходят на него по одному — сменой `"image"` в своём
   `devcontainer.json`.

При сборке образ проверяет, что установленные версии совпадают с lock-файлом, и падает, если нет.

## Поддержка этого репозитория

- **GitHub.** Workflow *env image* собирает `r-env` при push с изменениями в `env/` (или вручную: Actions →
  env image → Run workflow). Тег — в summary запуска. Repository variable `DEFAULT_ENV_IMAGE` (Settings →
  Variables) нужна для еженедельной сборки слоя Positron. Новый пакет в реестре по умолчанию приватный;
  `r-env` сделан публичным (организация → Packages → r-env → Package settings → Change visibility).
- **Реестр с этой машины** (только для push и приватных образов):
  `gh auth refresh -s write:packages && gh auth token | docker login ghcr.io -u <github-user> --password-stdin`.

## Агенты и CI (следующий шаг)

Образ окружения уже содержит всё нужное, слой Positron для этого не нужен:

- **агент**: `docker run --rm ghcr.io/<owner>/r-env:<тег> ...` с клоном репозитория, где данные остаются
  зашифрованы git-crypt; агент пишет qmd/Rmd и открывает PR;
- **CI в PR**: тот же образ, `git-crypt unlock` ключом из секрета, `quarto render`, ссылка на HTML в Telegram.
  Проекты живут в Gitea, поэтому CI — это Gitea Actions (или аналог на нашей стороне).

## Проверки перед коммитом

`./lint.sh` проверяет shell-скрипты (синтаксис и shellcheck), workflows GitHub Actions (actionlint, включая
shellcheck их `run:`), Dockerfile (hadolint) и то, что вне `*.md` нет кириллицы. Те же проверки запускаются
в CI на каждый push и pull request ([lint.yml](.github/workflows/lint.yml)).

Один раз после клонирования включите запуск перед каждым коммитом:

```bash
brew install shellcheck actionlint hadolint   # необязательно: без них lint.sh запустит их из Docker
./lint.sh --install-hook
```

Пропустить проверку разово: `git commit --no-verify` (CI всё равно проверит). Настройки линтеров:
[.shellcheckrc](.shellcheckrc), [.hadolint.yaml](.hadolint.yaml) — там же объяснено, что и почему отключено.

## Файлы

- [project-template/](project-template/): `.devcontainer/` для шаблона проекта в Gitea
- [docs/kak-rabotat.md](docs/kak-rabotat.md): простая инструкция для коллег
- [docs/new-project.md](docs/new-project.md): пошаговая работа с проектом
- [env/](env/): образ окружения `r-env` (Dockerfile, renv.lock, подбор даты снимка)
- [positron/](positron/): слой Positron для run-positron.sh (Dockerfile, `positron-entrypoint`, `positron-projects`)
- [.github/workflows/](.github/workflows/): сборка `r-env` и слоя Positron, линтеры
- [run-positron.sh](run-positron.sh): запуск контейнера проекта на любом Docker-хосте
- [build-image.sh](build-image.sh): сборка слоя Positron (вызывается из run-positron.sh и CI)
- [inspect-container.sh](inspect-container.sh): параметры существующих контейнеров, список R-пакетов
- [lint.sh](lint.sh), [.githooks/](.githooks/): проверки перед коммитом
- [lib.sh](lib.sh): общие функции и конфиг; [positron.env.example](positron.env.example): шаблон конфига

Скачанные архивы Positron кешируются в `.cache/downloads/` (около 530 МБ каждый, старые можно удалять).
