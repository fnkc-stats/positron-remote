# Справочник

Полный перечень того, что умеет FNKC Projects: команды расширения и командной строки, настройки клиента и сервера, команды внутри контейнера, скрипты и workflow CI. Подробные инструкции — в [README](../README.md), [инструкции для аналитиков](workflow.md), [руководстве оператора](operations.md) и [Lifecycle invariants](lifecycle.md). Тест `ctl/test/docs.test.ts` (часть `./lint.sh` и pre-commit) проверяет, что каждая команда, настройка, ключ конфигурации, флаг, скрипт и workflow упомянуты в документации.

## Расширение Positron

### Команды (Cmd/Ctrl+Shift+P, категория «FNKC Projects»)

| Команда | Что делает |
| --- | --- |
| Open Project… | Спрашивает репозиторий (имя, `владелец/имя`, ссылку из Gitea или URL) и хост, запускает контейнер проекта и открывает его в новом окне. Если данные зашифрованы, спрашивает, расшифровать ли их. Кнопка **Cancel** в уведомлении прерывает открытие. Если работающий контейнер ждёт обновления, подключается к нему как есть и предупреждает об этом. |
| Stop Project… | Список работающих проектов на всех хостах; останавливает выбранный (тома сохраняются, `renv.lock` не меняется). |
| Stop This Project and Close the Window | В окне проекта (также кнопка ■ с именем проекта в строке состояния): сохраняет файлы, закрывает окно и останавливает проект в фоне. Ошибку фоновой остановки сообщит следующее окно Positron (**Stop Again**). |
| Build Environment… | Добавляет сервер выбранной версии Positron к R-окружению (окружение открытого проекта или новейшее окружение серии) в GitHub CI; нужен `gh auth login` с правом записи в `envRepository` (администраторы). Без него называет причину и предлагает Copy Request — просьбу для администратора. Открытие предлагает его само, если для окружения нет сервера вашей версии. |
| Check Setup | Проверяет компьютер (ключ SSH и ssh-agent, ключи хостов, Gitea, хосты, Docker, GnuPG и окно пароля, Positron, автоматические обновления Positron; на macOS — Homebrew, если команды им пользуются) и подсказывает исправление простыми словами, с командой для этой системы (apt или dnf на Linux, Homebrew на macOS, winget и PowerShell на Windows) и способом сделать то же вручную. Выбор строки показывает шаги: где выполнится команда и спросит ли она пароль компьютера или разрешение Windows. **Run It for Me** выполняет её в терминале Positron (команды для администратора Windows — в отдельном окне PowerShell с повышенными правами), затем проверка повторяется; если не помогло, объясняется почему (нет прав на установку, неверный пароль, нет интернета, идёт другая установка, нет места, отказ в окне Windows) и что делать дальше. **Copy Command** копирует команду, **Copy for the Administrator** — команду и ошибку для администратора. Первая строка, **Configuration**, называет серверы из настроек; без них предлагает импорт `config.json` (выбор строки запускает Import Configuration…), некорректная настройка показывается в ней же, а не ошибкой. Пока проверка ни разу не прошла целиком, она выполняется сама в фоне при запуске и при изменении настроек или `config.json` и напоминает о проблемах не чаще раза в день (**Don't Remind Me** выключает напоминания). |
| Import Configuration… | Выбор файла `config.json` от администратора: проверяет его (JSON, имена хостов, списки), предупреждает, если в нём нет сервера, и кладёт в `~/.config/fnkc-ctl/config.json` (или `FNKC_CTL_CONFIG`); прежний файл сохраняется как `config.json.bak`. Затем предлагает Check Setup. |
| Check for Updates | Ищет новый выпуск расширения (раз в день и так при запуске, отключается настройкой `checkForUpdates`). Предлагает обновление, только когда все серверы из настроек готовы к нему (порядок обновления: сначала сервер). Кнопка также в заголовке панели Projects. |
| Remove SSH Configuration | Убирает строку `Include fnkc/*.conf` из `~/.ssh/config` и папку `~/.ssh/fnkc`. |
| Clear Image Download Cache | Удаляет образы окружений, скачанные этим компьютером для отправки на хосты (`imageCacheLimit` ограничивает кеш и без этого). |
| Set Up Docker on This Computer (Windows, one time) | Запускает `ctl/windows/setup-wsl.ps1`: дистрибутив WSL2 `fnkc` с Docker Engine без Docker Desktop. Экспериментально. |
| Show Log | Журнал расширения (Output → FNKC Projects). |

### Панель Projects

Проекты на каждом хосте: имя, состояние, память. Кнопки строки проекта: **Open**, **Stop**, **Delete Project…** (только у остановленного: сначала отчёт о том, что не на Gitea, затем подтверждение). Строка хоста: **Open Project Here…** (открыть проект на этом хосте). Заголовок: **Refresh**, **Check for Updates**. Панель обновляется сама раз в минуту, пока видна. Без настроек вместо хостов панель пишет, что расширение не настроено, с кнопками **Import Configuration…** и **Check Setup**; при ошибке в настройках — саму ошибку и **Open Settings**.

### Панель Environment Images

По умолчанию скрыта: включите её в меню **…** в заголовке боковой панели FNKC (отметьте **Environment Images**). Опубликованные R-окружения по сериям, слои с сервером Positron, закрепления шаблонов Gitea и образы на хостах ([руководство оператора](operations.md#образы-окружения)). Команды: **Refresh Images**; на строке образа — **Copy Pin** (закрепление `repository@sha256:…`), **Pin in This Folder's container.json** (записать в `container.json` открытой папки), **Open CI Run**, **Open Build Commit**, **Show R Packages (renv.lock)**, **Compare with the Newest Build**; **Open the Registry on GitHub**; на образе хоста — **Copy Removal Command** (команда `sudo docker image rm` для администратора сервера) и **Remove from This Computer** (только Docker этого компьютера и только если образ не используется).

### Сообщения об ошибках

Кнопки по смыслу ошибки: **Stop a Project** (квота), **Retry** (занятая блокировка), **Copy for the Administrator** (решает администратор: версия сервера, ёмкость хоста, запрет запусков), иначе **Check Setup**; всегда **Show Log**.

### Настройки (Settings → FNKC Projects)

Настройки подключения — личные настройки компьютера (только глобальные значения; настройки рабочей области их не переопределяют). Те же ключи можно задать в `~/.config/fnkc-ctl/config.json` (ниже); значение в Positron имеет приоритет.

| Настройка | По умолчанию | Значение |
| --- | --- | --- |
| `hosts` | — | Разрешённые хосты: `{ "name": "server", "ssh": "fnkc@server" }`; без `ssh` — Docker этого компьютера (только если он указан явно, например `{ "name": "local" }`). Автоматический выбор берёт только первый. Пока хостов нет, расширение считается не настроенным (панель Projects и Open предлагают Import Configuration…), а `fnkc-ctl open`, `stop`, `list` и `remove` отказываются работать и говорят, где взять `config.json`. |
| `gitRemotes` | — | Где лежат репозитории проектов, например `ssh://git@gitea.example.lan:2221/stats`. |
| `sshKey` | `~/.ssh/id_ed25519` (или `id_ecdsa`, `id_rsa`) | Закрытый ключ для входа в контейнеры; его `.pub` попадает в новые контейнеры этого компьютера. |
| `gitCryptKey` | — | Файл общего ключа git-crypt (для проектов, зашифрованных не для личных ключей GPG). |
| `decryptionHosts` | `[]` | Серверы, на которых разрешено расшифровывать данные проектов (Docker этого компьютера разрешён всегда). |
| `localEngine` | `auto` | Какой Docker запускать для локальных проектов: `auto`, `colima`, `docker-desktop`, `wsl`, `system`. |
| `wslDistro` | `fnkc` | Дистрибутив WSL с Docker Engine (Windows). |
| `idleMinutes` | `0` | Остановка локальных контейнеров при простое (0 — никогда). Для сервера это решает администратор. |
| `envRepository` | `fnkc-stats/positron-remote` | Репозиторий GitHub с workflow образов и выпусками расширения (Build Environment, обновления, provenance). |
| `templateRepository` | `template-r-{series}` | Репозиторий шаблона каждой серии R в Gitea (панель Environment Images). |
| `checkForUpdates` | `true` | Раз в день искать новый выпуск расширения. |

## Командная строка `fnkc-ctl`

`node ctl/dist/fnkc-ctl.cjs <команда>` (на сервере — `fnkc-ctl`). Общий флаг `--config <файл>` (по умолчанию `$FNKC_CTL_CONFIG` или `~/.config/fnkc-ctl/config.json`); `--help`, `--version` (`--version --json` — протокол и возможности, которые нужны этой сборке от сервера).

| Команда | Что делает |
| --- | --- |
| `open <проект> [--host <имя>] [--unlock] [--no-window]` | Как Open Project; `--unlock` — расшифровать данные (или ошибка), `--no-window` — не открывать окно Positron, только подготовить. |
| `stop <проект> [--host <имя>] [--status-file <файл>]` | Остановить; без `--host` — на всех хостах. `--status-file` записывает результат в JSON (так расширение останавливает проект в фоне). |
| `list` | Контейнеры на всех хостах. |
| `remove <проект> --host <имя> [--delete] [--lose-work]` | Отчёт о том, что потеряет удаление; `--delete` удаляет, если вся работа на Gitea, `--delete --lose-work` — и иначе. |
| `images [--templates <шаблон>]` | Опубликованные окружения, закрепления шаблонов, образы на хостах. |
| `images --cleanup [--older-than <дней>] [--keep <файл>] [--delete]` | Что можно удалить из реестра; `--delete` удаляет ([руководство оператора](operations.md#образы-окружения)). |
| `build <окружение \| серия> [--positron <версия>] [--wait <run id>]` | Build Environment из командной строки; `--wait` — снова дождаться уже запущенной сборки. |
| `doctor` | Check Setup из командной строки; `--json` — результаты для скриптов. |
| `ssh-config [--remove]` | Есть ли строка Include в `~/.ssh/config`; `--remove` убирает её и `~/.ssh/fnkc`. |

На сервере (от root): `admin add-user <имя> <ключ>`, `admin remove-user <имя>` (ключ удаляется, затем каждый проект останавливается под своей блокировкой), `admin list-users`; флаги `--account <служебная учётная запись>` (по умолчанию `fnkc`) и `--agent-config <файл>`.

Агент (то, что вызывают команды выше; ответы в JSON): `agent ping | list | images | stop <проект> | remove-check <проект> | remove <проект> <отпечаток> | start | install-image <образ>` с `--user <имя>` и `--agent-config <файл>` (по умолчанию `$FNKC_CTL_AGENT_CONFIG` или `/etc/fnkc-ctl/agent.json`). `serve --user <имя>` — принудительная команда SSH служебной учётной записи: выполняет команду агента из `SSH_ORIGINAL_COMMAND`, а также `agent connect <проект>` (поток к SSH контейнера).

## Клиентская конфигурация `~/.config/fnkc-ctl/config.json`

Пример: [ctl/examples/config.json](../ctl/examples/config.json). Ключи настроек расширения выше (`hosts`, `gitRemotes`, `sshKey`, `gitCryptKey`, `decryptionHosts`, `localEngine`, `wslDistro`, `envRepository`, `templateRepository`) и ещё:

| Ключ | По умолчанию | Значение |
| --- | --- | --- |
| `local` | `{}` | Настройки агента для Docker этого компьютера: те же ключи, что в `agent.json` (ниже), например `allowedImages`, `limits`, `cranMirror`, `extraHosts`. Для этого компьютера `pullImages` по умолчанию `true`. |
| `cacheDir` | `~/.cache/fnkc-ctl` | Кеш клиента: частичные копии репозиториев для `container.json`, скачанные образы, provenance, блокировки. |
| `imageCacheLimit` | `20g` | Сколько места могут занимать скачанные образы; давно не использованные удаляются после отправки образа. Образы, которые другое открытие использовало в последние 6 часов, не удаляются, поэтому кеш может ненадолго превысить лимит. |

## Настройки сервера `/etc/fnkc-ctl/agent.json`

Пример: [ctl/examples/agent.json](../ctl/examples/agent.json). Установщик задаёт `lockDir`, `imageStagingDir` и `verifiedDir` в `/var/lib/fnkc-ctl`.

| Ключ | По умолчанию | Значение |
| --- | --- | --- |
| `allowedImages` | `["ghcr.io/fnkc-stats/r-env"]` | Точные репозитории образов, которые можно запускать (только с дайджестом). |
| `keysDir` | — | Ключи пользователей `<keysDir>/<user>.pub`; задан — значит, это сервер (ключ из запроса не принимается, provenance обязателен). |
| `limits` | `{ "memory": "4g", "cpus": "2", "pids": 512 }` | Ограничения каждого контейнера проекта. |
| `maxProjectsPerUser` | `2` | Сколько проектов пользователь может запускать одновременно; `0` — запуск запрещён (обслуживание). |
| `maxMemoryPerUser` | `16g` | Сумма `limits.memory` работающих проектов пользователя. |
| `reserveMemory` | `2g` | Память хоста, которую допуск не раздаёт. |
| `idleMinutes` | `0` | Остановка при простое (0 — никогда). |
| `idleCheckSeconds` | — | Секунд на одну проверку простоя (только для тестов; иначе 60). |
| `skipExtensions` | Jupyter, Python, Ruff, Pyrefly, GitHub PR | Встроенные расширения Positron, которые не ставятся в контейнеры (префиксы id); `[]` — ставить все. |
| `pullImages` | `false` | Пробовать `docker pull` недостающего образа до загрузки с клиента. |
| `imageStagingDir` | `~/.cache/fnkc-ctl/images/…` | Где принимаются и проверяются загруженные образы. |
| `imageReserve`, `maxUnpackedImage`, `maxImageStorage` | `2g`, `64g`, `128g` | Границы загрузки образов ([Lifecycle invariants](lifecycle.md#upload-and-storage-bounds)). |
| `lockDir` | `~/.cache/fnkc-ctl/locks/…` | Каталог блокировок; один на демон Docker. |
| `docker` | `docker` | Команда Docker, возможно с префиксом (`["wsl", "-d", "fnkc", "--exec", "docker"]`). |
| `extraHosts` | `{}` | Имена хостов для контейнеров (`--add-host`), например только из DNS VPN. |
| `cranMirror` | `https://mirror.truenetwork.ru/CRAN/` | Зеркало CRAN для пакетов, которых нет в образе. |
| `requireProvenance` | `true` при `keysDir` | Требовать GitHub Artifact Attestation образа перед созданием контейнера. |
| `provenanceRepository`, `provenanceWorkflow` | `fnkc-stats/positron-remote`, `.github/workflows/positron.yml` | Кто должен был подписать образ (ветка `refs/heads/main`). |
| `trustedRootFile` | `/etc/fnkc-ctl/trusted-root.jsonl` | Корень доверия Sigstore для офлайн-проверки; обновляется еженедельно. |
| `verifiedDir` | `~/.cache/fnkc-ctl/verified/…` | Дайджесты, прошедшие проверку provenance. |

## Внутри контейнера: `fnkc-projects`

| Команда | Что делает |
| --- | --- |
| `fnkc-projects status` | `git status` с веткой и расшифрованы ли данные. |
| `fnkc-projects sync` | Только `git fetch --prune`: не делает слияние и не переключает ветки. |
| `fnkc-projects run <команда>` | Запускает долгую задачу так, что остановка при простое её не прервёт. |
| `fnkc-projects snapshot` | Записывает установленные R-пакеты в `renv.lock` (только явно). |
| `fnkc-projects unlock <файл ключа>` | Расшифровывает рабочую копию git-crypt ключом (GPG или общим), файл удаляется. |
| `fnkc-projects lock` | Снова блокирует git-crypt (рабочая копия должна быть чистой). |
| `fnkc-projects data` | `none`, `locked` или `unlocked`: используют ли файлы git-crypt и расшифрована ли рабочая копия (спрашивает Open). |
| `fnkc-projects init <проект> <коммит> <репозиторий>` | Первое клонирование внутри контейнера (вызывает Open). |

Скрипты, которые fnkc-ctl копирует в контейнер при создании: `entrypoint.sh` (запуск: ключ входа, владельцы томов, настройки R и renv, зеркало CRAN, ключи хоста sshd, остановка без изменения зависимостей), `idle-watch.sh` (остановка при простое, если включена; состояние в `/run/fnkc-idle`), `fnkc-projects.sh` (команды выше), `Rprofile.R`, `environment.R` и `snapshot.R` (проверка и восстановление `renv.lock`, явный snapshot).

## Скрипты

| Скрипт | Где | Что делает |
| --- | --- | --- |
| `install.sh` | сервер | Установка или обновление сервера ([admin-setup.md](admin-setup.md)). |
| `refresh-trust-root.sh` | сервер | Обновляет корень доверия Sigstore; еженедельно по таймеру `fnkc-ctl-trust-root.timer`. |
| `volume-backup.sh` | сервер | Зашифрованное резервное копирование и восстановление томов restic ([operations.md](operations.md#резервное-копирование-и-учения-по-восстановлению)). |
| `render-reviewed.py` | сервер | Рендер согласованного коммита на отдельном хосте ([data-execution.md](data-execution.md)). |
| `setup-wsl.ps1` | Windows | Docker в WSL2 для FNKC Projects. |
| `inspect-container.sh` | любой | Настройки и R-пакеты существующего контейнера (перенос старой настройки в `env/`). |
| `env/build.sh`, `env/lock.sh`, `env/positron.sh`, `env/quarto.sh`, `env/inputs.sh`, `env/published.sh` | разработка образов | Сборка, `renv.lock` серии, закрепление Positron, закрепление Quarto контрольными суммами, входные данные окружения, поиск опубликованного ([r-packages.md](r-packages.md)). |
| `checks/run.sh` | разработка образов | Проверки R-окружения в образе ([checks/README.md](../checks/README.md)). |
| `lint.sh` | разработка | Все статические проверки (и pre-commit: `./lint.sh --install-hook`). |
| `.github/scripts/publish-release.sh` | CI | Публикация выпуска расширения (шаг `extension.yml`): выпускается только новейший коммит main (если более новые коммиты меняют расширение, выпуск сделает их запуск), повторные попытки, «последним» становится только более новая версия. Проверяется локально тестом `ctl/test/release.test.ts`. |
| `ci-local.sh` | разработка | Задания CI на этом компьютере теми же скриптами, что вызывает CI: `quick` (`lint.sh` и `npm audit`), `integration [образ]` (`ctl/test/integration.sh`), `image <серия>` (`env/build.sh` и `env/check-image.sh`), `all`. |
| `env/check-image.sh` | разработка образов | Проверки R-окружения перед публикацией, как в `image.yml`: метки, `verify.R` и отчёт, сервер Positron поверх, проверки R, `test:ssh`. |

Тесты: `npm --prefix ctl test` (модульные), `npm --prefix ctl run test:ssh`, `test:removal`, `test:windows`, `test:check-setup` (Check Setup на этом компьютере; с `FNKC_SYSTEM_TESTS=1` устанавливает программы — только в CI), `test:provenance -- <образ>` (provenance с настоящими данными; `ctl/test/provenance-pin.sh` — для Positron-образа закрепления шаблона), `ctl/test/e2e.sh`, `ctl/test/clone-integration.sh`, `ctl/test/environment-integration.sh`, `ctl/test/backup-integration.py`.

## Workflow CI

| Workflow | Когда | Что делает |
| --- | --- | --- |
| `lint.yml` | pull request, main | `./lint.sh` (gitleaks — по всей истории, включая коммиты pull request). |
| `ctl-checks.yml` | из extension.yml и r-checks.yml | `./lint.sh`, `npm audit`, интеграционные тесты (SSH, резервное копирование, удаление, клонирование, R-окружение, e2e); настоящая проверка provenance опубликованного Positron-образа закрепления шаблона (`ctl/test/provenance-pin.sh`): без неё выпуск не публикуется. |
| `extension.yml` | изменения `ctl/` | Проверки, сборка; в main — выпуск: `.vsix`, пакет сервера, контрольные суммы, `fnkc-projects-compat.json`, аттестации. |
| `windows-client.yml` | изменения `ctl/` | Typecheck, приёмочные тесты Windows и сборка на Windows. |
| `check-setup.yml` | изменения `ctl/src/` | Check Setup на настоящих Ubuntu, macOS и Windows: со скрытыми программами находит все проблемы и описывает их понятно; предложенные команды выполняются по-настоящему (apt, Homebrew, systemctl, окно PowerShell администратора, ssh к локальному sshd), и проверка повторяется (`npm --prefix ctl run test:check-setup`, `FNKC_SYSTEM_TESTS=1`). |
| `env-image.yml` | изменения `env/`, `ctl/`, `checks/`, workflow образов; вручную | Для каждой серии R вызывает `image.yml`. |
| `image.yml` | из env-image.yml | Сборка или повторное использование окружения обеих архитектур, проверки R (если могли измениться), отчёт Trivy, тест SSH; в main — публикация и `positron.yml`. |
| `positron.yml` | из image.yml; Build Environment | Слой с сервером Positron, публикация, аттестация и проверка аттестации так, как её делает сервер. |
| `r-checks.yml` | изменение `project-template/container.json`; вручную | Проверки R-окружения на образе шаблона или заданном; `ctl-checks.yml` (интеграционные тесты на новом закреплении, его Positron-образ опубликован и проходит проверку provenance). |
