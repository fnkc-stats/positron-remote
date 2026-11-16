# positron-remote

Воспроизводимые рабочие окружения для проектов: каждый проект открывается в Positron внутри своего контейнера
с R и пакетами — **в основном на сервере**, а при желании на своём компьютере. Тот же образ окружения
используют CI (сборка отчётов с данными) и агенты (без доступа к данным).
Обсуждение и мотивация: [meeting-summary.md](meeting-summary.md).

## Как это работает

Контейнеры запускает **`positron-ctl`** ([ctl/](ctl/)): одна программа на TypeScript, которая работает
и на компьютере пользователя, и на сервере. Позже на ней будет построено расширение для Positron
с кнопками «Запустить / Открыть / Остановить»; сейчас она работает из командной строки.

```
 компьютер пользователя            сервер (или этот же компьютер)
┌──────────────────────────────┐                    ┌──────────────────────────────────┐
│ positron-ctl open thesis     │ ── ssh positron@ ─▶│ positron-ctl serve --user anna   │
│  1. образ из container.json  │                    │  проверяет запрос и запускает    │
│  2. ~/.ssh/positron/*.conf   │                    │  контейнер positron-anna-thesis  │
│                              │                    │                                  │
│ Positron Remote SSH          │ ─── ProxyJump ────▶│ sshd контейнера на 127.0.0.1     │
└──────────────────────────────┘                    └──────────────────────────────────┘
```

1. Из репозитория проекта в Gitea читается `container.json` — какой образ окружения нужен проекту.
2. Выбирается хост: первый доступный из списка (обычно сервер, потом этот компьютер) или заданный явно.
3. **Агент** на хосте запускает контейнер `positron-<пользователь>-<проект>`. На сервере агент — это
   единственное, что пользователь может вызвать по SSH (forced command в `authorized_keys`): доступа
   к Docker у пользователей нет, а агент разрешает только свои контейнеры, только образы из нашего реестра
   и с лимитами памяти/CPU. Локально тот же агент работает внутри `positron-ctl`.
4. На компьютере пользователя пишется `~/.ssh/positron/<проект>.conf` с хостом `positron-<проект>`.
5. Проект клонируется в контейнер (`~/<проект>`, свой том) по SSH с пробросом ssh-agent — git ходит
   в Gitea ключами пользователя, токены нигде не хранятся. Positron открывает `positron-<проект>` через
   Remote SSH.

Образ `r-env` при этом не меняется и отдельный «слой Positron» не нужен:

- **сервер Positron** под версию клиента пользователя хост скачивает один раз в общий том
  `positron-server-<arch>` (`bin/<commit>`), который подключается во все контейнеры только для чтения;
- **точка входа** (sshd) и `positron-projects` копируются в контейнер при создании.

Обновили Positron — при следующем `open` хост докачает новую версию сервера, контейнер пересоздавать
не нужно. Сменился образ в `container.json` — контейнер пересоздаётся, тома с проектом и настройками
Positron остаются.

## Проект: `container.json`

В корне репозитория проекта (шаблон: [project-template/container.json](project-template/container.json)):

```json
{
  "image": "ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7"
}
```

Обновить окружение проекта = сменить тег отдельным коммитом. Тег всегда конкретный, не `latest`.
У старых проектов, где ещё лежит `.devcontainer/devcontainer.json`, образ берётся из его строки `"image"`.

## Расширение для Positron

`cd ctl && npm ci && npm run package` собирает `ctl/dist/positron-projects.vsix`; установка:
*Extensions → … → Install from VSIX* (или `positron --install-extension positron-projects.vsix`).
Команды (`Cmd/Ctrl+Shift+P`): **Positron Projects: Open Project…**, **…with Decrypted Data…**,
**Stop Project…**, **Show Log**. Настройки — раздел *Positron Projects* в настройках Positron; что там не задано,
берётся из `~/.config/positron-ctl/config.json` (общий файл с командной строкой).

**Остановка.** В окне проекта внизу слева кнопка **■ <проект> (<хост>)**: сохраняет открытые файлы,
останавливает контейнер и закрывает окно. Забытый контейнер останавливается сам, когда к нему никто
не подключён и он ничего не считает (CPU < 5% ядра): на своём компьютере через 30 минут (настройка
*Idle Minutes*), на сервере через 2 часа (`idleMinutes` в `agent.json`); `0` — никогда. Долгий расчёт в R
с закрытым окном продолжается, контейнер остановится после него. Файлы и настройки Positron лежат на томах
и не теряются; следующий Open запускает контейнер снова. Остановившиеся контейнеры не поднимаются сами
после перезагрузки сервера.

## Docker на своём компьютере

Docker запускается сам, когда проект открывают на этом компьютере, и останавливается после остановки
последнего локального проекта — но только если его запустил `positron-ctl`; запущенный вручную Docker
не трогается, как и Docker, в котором работают другие контейнеры. Держать Docker запущенным постоянно не нужно.

- **macOS:** Colima (`brew install colima docker`) или Docker Desktop. Для образов amd64 на Apple Silicon
  в Colima нужен Rosetta (`vmType: vz`, `rosetta: true`), в Docker Desktop — *Use Rosetta for x86/amd64 emulation*.
- **Windows:** без Docker Desktop — маленький Alpine Linux `positron` в WSL2 с Docker Engine внутри.
  Один раз: команда **Positron Projects: Set Up Docker on This Computer** (или
  `powershell -ExecutionPolicy Bypass -File ctl\windows\setup-wsl.ps1`). Включение самого WSL требует прав
  администратора и перезагрузки; скрипт скажет, когда запустить его ещё раз. Он же проверяет git, ssh
  и службу ssh-agent. Удалить всё: `wsl --unregister positron`. Docker Desktop тоже работает.
- **Linux:** системная служба Docker.

Выбор можно задать явно: `localEngine` (`colima`, `docker-desktop`, `wsl`, `system`) и `wslDistro` в настройках.

## Командная строка

Нужны Node.js 22+, Docker (для локальных контейнеров), `git` и `ssh`.

```bash
cd ctl && npm ci && npm run build           # dist/positron-ctl.cjs
mkdir -p ~/.config/positron-ctl
cp ctl/examples/config.json ~/.config/positron-ctl/config.json   # заполнить hosts и gitRemotes

node ctl/dist/positron-ctl.cjs open thesis               # первый доступный хост; откроет окно Positron
node ctl/dist/positron-ctl.cjs open thesis --host local  # на этом компьютере
node ctl/dist/positron-ctl.cjs open thesis --unlock      # плюс git-crypt unlock ключом gitCryptKey
node ctl/dist/positron-ctl.cjs stop thesis               # остановить (тома остаются)
node ctl/dist/positron-ctl.cjs list                      # контейнеры на всех хостах
```

Настройки ([ctl/examples/config.json](ctl/examples/config.json)): `hosts` — хосты в порядке выбора
(`ssh` — учётная запись `positron` на сервере; без `ssh` — Docker на этом компьютере), `gitRemotes` — где
лежат репозитории проектов, `sshKey` — ключ для входа в контейнеры (по умолчанию `~/.ssh/id_ed25519`),
`gitCryptKey`, `defaultImage` для проектов без `container.json`, `local` — правила для локального Docker
(те же поля, что у агента на сервере).

`~/.ssh/config` должен начинаться со строки `Include positron/*.conf` — `positron-ctl` добавляет её сам.

В контейнере `positron-projects status` показывает незакоммиченное и неотправленное, а `positron-projects sync`
подтягивает свежие изменения, не трогая существующую работу. Между хостами работа переезжает только через
git: перед переездом нужно сделать push (`positron-ctl` предупредит, если проект запущен ещё где-то).

## Память

Открытый проект занимает около 1,5 ГБ памяти ещё до загрузки данных (Positron в контейнере + R). Что сделано,
чтобы её хватало всем:

- **Лимит на контейнер:** `limits.memory` в `agent.json` (для сервера на 32 ГБ и 4 человек — `8g`); без
  настройки — 75% памяти хоста. Своп сверх лимита не используется. При превышении останавливается сессия R,
  а не весь контейнер: Positron предлагает перезапустить R, а новая сессия объясняет, что произошло.
- **Остановка забытых проектов:** `idleMinutes` (на сервере по умолчанию 60, на своём компьютере 30).
- **Лишние расширения не ставятся в контейнеры:** Jupyter, инструменты Python (ruff, pyrefly, debugpy) и
  GitHub Pull Requests (`skipExtensions` в `agent.json` или в `local`; `[]` — ставить все). Quarto с R это не
  затрагивает: документы считает knitr, а `quarto render` в HTML работает как раньше; не будет только
  редактора `.ipynb` и Python-чанков через Jupyter.
- **Видно, кто сколько занимает:** память у каждого запущенного проекта в панели *Projects* и в
  `positron-ctl list`; на сервере — `docker stats`.

## Сервер

Проверено на «сервере-дублёре» (контейнер Ubuntu 24.04 с sshd на этом компьютере); на настоящем сервере
ещё не запускалось.

Нужны Linux с Docker Engine и Node.js 20+; сервер должен видеть `ghcr.io` и `cdn.posit.co` (иначе архивы
сервера Positron кладутся в папку `serverArchiveDir` из `agent.json`).

```bash
cd ctl && npm ci && npm run server-bundle        # на своём компьютере: dist/positron-ctl-server.tar.gz
scp dist/positron-ctl-server.tar.gz admin@server:
# на сервере:
tar -xzf positron-ctl-server.tar.gz && sudo ./positron-ctl-server/install.sh
sudo positron-ctl admin add-user anna anna.pub   # ключ — тот же, что у неё в Gitea
sudo positron-ctl admin list-users
sudo positron-ctl admin remove-user anna         # контейнеры и тома при этом остаются
```

`install.sh` ставит программу в `/opt/positron-ctl/` (и команду `positron-ctl` для админа), создаёт
`/etc/positron-ctl/agent.json` (разрешённые образы, лимиты, `idleMinutes`; лимит CPU больше, чем есть
на сервере, урезается сам) и служебную учётную запись `positron` в группе `docker`, проверяет настройки sshd
(проброс портов должен быть разрешён). Повторный запуск обновляет программу, настройки и пользователи
сохраняются.

`add-user` пишет ключ в `/etc/positron-ctl/keys/<имя>.pub` и строку в `~positron/.ssh/authorized_keys`:

```
command="/usr/bin/node /opt/positron-ctl/positron-ctl.cjs serve --user anna",restrict,port-forwarding,permitopen="127.0.0.1:*" ssh-ed25519 AAAA... positron-ctl:anna
```

С этим ключом можно только вызывать агента (`agent ping|list|stop|start`) от имени `anna` и пробрасывать
соединение к sshd контейнеров на `127.0.0.1` сервера (это нужно Remote SSH); оболочка, чтение файлов,
проброс на другие адреса запрещены. Войти в чужой контейнер нельзя: в нём только ключ его владельца.
Пользователям учётные записи на сервере не нужны. У коллеги в настройках:
`hosts: [{ "name": "server", "ssh": "positron@<сервер>" }, { "name": "local" }]`.

Ключ git-crypt на сервер попадает только внутрь контейнера (`git-crypt unlock` хранит его в `.git` проекта) —
это стоит учитывать при выборе сервера.

## Обновление общего окружения

Пакеты и их версии задаёт [env/renv.lock](env/renv.lock). Чтобы обновить окружение:

1. заменить `env/renv.lock` новым курируемым lock-файлом;
2. в [env/Dockerfile](env/Dockerfile) выставить `R_VERSION` равным версии R из lock-файла, а `CRAN_SNAPSHOT` —
   дате, которую выведет `env/snapshot-date.sh` (на эту дату все версии из lock-файла есть в Posit Package Manager
   бинарными, и сборка идёт минуты, а не часы);
3. push в `main` соберёт новый тег. Проекты переходят на него по одному — сменой `"image"` в своём
   `container.json`.

При сборке образ проверяет, что установленные версии совпадают с lock-файлом, и падает, если нет.
Если пакет нужен только одному проекту, его пока тоже добавляют в общий `env/renv.lock`
(образы отдельных проектов — следующий шаг).

Чтобы перенести существующую рабочую среду в `env/`:

```bash
./inspect-container.sh --host ssh://user@server                      # контейнеры на хосте
./inspect-container.sh --host ssh://user@server <контейнер>          # образ, тома, ОС, есть ли quarto/git-crypt
./inspect-container.sh --host ssh://user@server <контейнер> --r-packages   # версия R и пакеты: сверить с env/renv.lock
```

## Поддержка этого репозитория

- **GitHub.** Workflow *env image* собирает `r-env` при push с изменениями в `env/` (или вручную: Actions →
  env image → Run workflow). Тег — в summary запуска. Пакет `r-env` публичный: в нём нет данных и секретов,
  и он скачивается без входа в реестр.
- **Исходники проектов всегда в Gitea**; на GitHub — только образы и этот репозиторий.
- **Данные** лежат в репозиториях проектов зашифрованными (git-crypt). Ключ есть только у людей, не в образах.

## Агенты и CI (следующий шаг)

- **агент**: `docker run --rm ghcr.io/<owner>/r-env:<тег> ...` с клоном репозитория, где данные остаются
  зашифрованы git-crypt; агент пишет qmd/Rmd и открывает PR;
- **CI в PR**: тот же образ, `git-crypt unlock` ключом из секрета, `quarto render`, ссылка на HTML в Telegram.
  Проекты живут в Gitea, поэтому CI — это Gitea Actions (или аналог на нашей стороне).

## Проверки перед коммитом

`./lint.sh` проверяет shell-скрипты (синтаксис и shellcheck), workflows GitHub Actions (actionlint, включая
shellcheck их `run:`), Dockerfile (hadolint), `positron-ctl` (типы, тесты, сборка) и то, что вне `*.md` нет
кириллицы. Те же проверки запускаются в CI на каждый push и pull request ([lint.yml](.github/workflows/lint.yml)).

Один раз после клонирования включите запуск перед каждым коммитом:

```bash
brew install node shellcheck actionlint hadolint   # линтеры необязательны: без них lint.sh запустит их из Docker
./lint.sh --install-hook
```

Пропустить проверку разово: `git commit --no-verify` (CI всё равно проверит). Настройки линтеров:
[.shellcheckrc](.shellcheckrc), [.hadolint.yaml](.hadolint.yaml) — там же объяснено, что и почему отключено.

## Файлы

- [ctl/](ctl/): `positron-ctl` — `src/agent.ts` (хост), `src/client/` (компьютер пользователя),
  `src/extension.ts` (расширение), `src/client/engine.ts` (запуск Docker), `container/` (точка входа и
  `positron-projects`, копируются в контейнер), `src/admin.ts` и `server/install.sh` (сервер),
  `windows/setup-wsl.ps1`, `examples/` (настройки), `test/`
- [project-template/container.json](project-template/container.json): файл для шаблона проекта в Gitea
- [env/](env/): образ окружения `r-env` (Dockerfile, renv.lock, подбор даты снимка)
- [docs/workflow.md](docs/workflow.md): пошаговая инструкция для коллег (будет переписана под расширение)
- [inspect-container.sh](inspect-container.sh): параметры существующих контейнеров, список R-пакетов
- [lint.sh](lint.sh), [.githooks/](.githooks/), [.github/workflows/](.github/workflows/): проверки и сборка `r-env`
