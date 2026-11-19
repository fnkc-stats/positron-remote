# FNKC Projects

Открывает проект в отдельном контейнере, на сервере или на этом компьютере, и подключает к нему Positron. Репозиторий клонируется внутри контейнера; проект в списке называется как репозиторий в Gitea. Нужен Positron той версии, для которой собран образ проекта (сервер Positron входит в образ).

Команды (Cmd/Ctrl+Shift+P):

- **FNKC Projects: Open Project…** (если данные проекта зашифрованы, спросит, расшифровать ли их)
- **FNKC Projects: Stop Project…** (файлы в контейнере сохраняются, R-пакеты записываются в `renv.lock`)
- **FNKC Projects: Build Environment…** (новый образ в GitHub CI для серии R и версии Positron, по умолчанию — этой; затем предлагает закрепить его в `container.json` открытого проекта; нужен `gh auth login`)
- **FNKC Projects: Show Log**

Настройки: *FNKC Projects* в настройках Positron или `~/.config/fnkc-ctl/config.json`.
Тот же код доступен как командная строка `fnkc-ctl` (см. README репозитория).
