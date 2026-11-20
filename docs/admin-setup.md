# Что настроить нам

## 1. Сервер

1. Соберите и установите:

   ```bash
   npm ci --prefix ctl && npm --prefix ctl run server-bundle
   # скопируйте ctl/dist/fnkc-ctl-server.tar.gz на сервер, затем там:
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

   - `container.json`: `{ "image": "ghcr.io/fnkc-stats/r-env@sha256:<дайджест этой серии>" }`;
   - `renv.lock`: копия `env/versions/<серия>/renv.lock` из того коммита этого репозитория, из которого собран этот дайджест;
   - `.gitignore` (например `.Rhistory`, `.Rproj.user/`, `renv/library/`).
2. Когда опубликован новый образ серии (новые пакеты или новая версия Positron, см. [README](../README.md#версия-positron)) (дайджест в сводке workflow **publish-manifest**), обновите в шаблоне `container.json` и `renv.lock` одним коммитом. Существующие проекты при этом не меняются; переводите их по одному коммитом с ревью. Отстал ли шаблон, видно в панели **Environment Images** расширения: у серии написано «template pins an older image», а кнопка копирования на строке серии копирует закрепление самого нового образа.

## 3. Пользователи

1. Добавление: `sudo fnkc-ctl admin add-user <имя> <имя>.pub` на сервере; пользователь сам добавляет тот же ключ в Gitea.
2. Отключение: `sudo fnkc-ctl admin remove-user <имя>`, затем архивируйте его тома по политике хранения.

## 4. Что раздать команде

По доверенному каналу (не тем же каналом, которым может воспользоваться посторонний):

- `fnkc-projects.vsix`: `npm --prefix ctl run package` → `ctl/dist/fnkc-projects.vsix`.
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
