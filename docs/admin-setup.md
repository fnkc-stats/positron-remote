# Что настроить нам

## 1. Сервер

1. Возьмите `fnkc-ctl-server.tar.gz` из [последнего выпуска](https://github.com/fnkc-stats/positron-remote/releases/latest) (CI публикует его вместе с расширением после каждого изменения `ctl/` в main, с файлом `.sha256`) или соберите сами: `npm ci --prefix ctl && npm --prefix ctl run server-bundle` → `ctl/dist/fnkc-ctl-server.tar.gz`. Скопируйте его на сервер, сверьте контрольную сумму и установите:

   ```bash
   sha256sum -c fnkc-ctl-server.tar.gz.sha256
   tar xzf fnkc-ctl-server.tar.gz && sudo ./fnkc-ctl-server/install.sh
   ```
2. Настройте `/etc/fnkc-ctl/agent.json` (образец: [ctl/examples/agent.json](../ctl/examples/agent.json)):

   - `allowedImages`: `ghcr.io/fnkc-stats/r-env`;
   - `limits` (память, CPU, процессы на проект), `maxProjectsPerUser`, `maxMemoryPerUser`, `reserveMemory`;
   - `idleMinutes`: 0;
   - `pullImages`: `true`, только если у сервера есть доступ к реестру.
3. Проверьте: `sudo sshd -T -C user=fnkc,host=localhost,addr=127.0.0.1 | grep disableforwarding` → `yes`.

## 2. Gitea

1. Шаблоны: по одному репозиторию на версию R, например `template-r-4.2`, `template-r-4.5`, `template-r-4.6`. В каждом:

   - `container.json`: `{ "image": "ghcr.io/fnkc-stats/r-env@sha256:<дайджест окружения этой серии>" }` — R-окружение (тег `<серия>-env-…`, дайджест в сводке workflow **publish-manifest**), не образ с сервером Positron;
   - `renv.lock`: копия `env/versions/<серия>/renv.lock` из того коммита этого репозитория, из которого собран этот дайджест;
   - `.gitignore` (например `.Rhistory`, `.Rproj.user/`, `renv/library/`);
   - `renv/.gitignore` (`library/`, `local/`, `cellar/`, `lock/`, `python/`, `sandbox/`, `staging/`), иначе в каждом новом проекте `renv/` виден как неотслеживаемый.
2. Когда опубликовано новое окружение серии (новые пакеты, см. [README](../README.md#версия-positron)), обновите в шаблоне `container.json` и `renv.lock` одним коммитом. Новая версия Positron шаблоны не меняет. Существующие проекты при этом не меняются; переводите их по одному коммитом с ревью. Отстал ли шаблон, видно в панели **Environment Images** расширения: у серии написано «template pins an older environment», а кнопка копирования на строке серии копирует закрепление самого нового окружения.

## 3. Пользователи

1. Добавление: `sudo fnkc-ctl admin add-user <имя> <имя>.pub` на сервере; пользователь сам добавляет тот же ключ в Gitea.
2. Отключение: `sudo fnkc-ctl admin remove-user <имя>`, затем архивируйте его тома по политике хранения.

## 4. Что раздать команде

По доверенному каналу (не тем же каналом, которым может воспользоваться посторонний):

- Заполненный `config.json` по образцу [ctl/examples/config.json](../ctl/examples/config.json): адрес сервера в `hosts` (`fnkc@<сервер>`), `gitRemotes` (`ssh://git@<gitea>:2221/stats`). Хост `local` оставьте, только если люди будут запускать проекты у себя; `decryptionHosts` по умолчанию пустой.
- Отпечатки ключей хостов:
  ```bash
  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub        # сервер, на самом сервере
  ssh-keyscan -p 2221 <gitea> 2>/dev/null | ssh-keygen -lf -   # Gitea; сверьте с ключом в его конфигурации
  ```

Сервер и расширение обновляйте одновременно: версии клиента и сервера должны совпадать.

Назовите команде версию Positron из [env/positron.args](../env/positron.args) (сейчас 2026.11.1-4): все ставят её и выключают автоматические обновления (Check Setup).

## 5. Резервное копирование

Внешний зашифрованный репозиторий restic, копирование томов `<base>-project`, `<base>-data` и `<base>-library` остановленных проектов скриптом `/opt/fnkc-ctl/volume-backup.sh`, ежемесячная проверка восстановления. Порядок: [operations.md](operations.md#резервное-копирование-и-учения-по-восстановлению).

## Выпуски расширения

После каждого изменения `ctl/` в main workflow [extension.yml](../.github/workflows/extension.yml) собирает, тестирует и публикует выпуск `fnkc-projects-v<версия>`: `fnkc-projects.vsix`, `fnkc-ctl-server.tar.gz` и контрольные суммы. Версия — `<major.minor из ctl/package.json>.<номер запуска>`, так что каждый выпуск новее предыдущего. Установленные расширения раз в день спрашивают последний выпуск (без учётных данных, репозиторий публичный), предлагают **Update**, сверяют скачанный файл с его `.sha256` и устанавливают его. Отключить проверку: настройка `fnkcProjects.checkForUpdates`. Ссылка для первой установки не меняется: `https://github.com/fnkc-stats/positron-remote/releases/latest/download/fnkc-projects.vsix`. Сервер сам не обновляется: новую версию `fnkc-ctl-server.tar.gz` из того же выпуска администратор ставит, как в шаге 1, когда в выпуске есть изменения агента.
