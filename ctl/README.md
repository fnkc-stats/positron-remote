# FNKC Projects

Открывает проект в отдельном контейнере, на сервере или на этом компьютере, и подключает к нему Positron. Репозиторий клонируется внутри контейнера; проект в списке называется как репозиторий в Gitea. Нужен Positron той версии, для которой собран образ проекта (сервер Positron входит в образ).

Команды (Cmd/Ctrl+Shift+P):

- **FNKC Projects: Open Project…** (или **…with Decrypted Data**)
- **FNKC Projects: Stop Project…** (файлы в контейнере сохраняются, R-пакеты записываются в `renv.lock`)
- **FNKC Projects: Show Log**

Настройки: *FNKC Projects* в настройках Positron или `~/.config/fnkc-ctl/config.json`.
Тот же код доступен как командная строка `fnkc-ctl` (см. README репозитория).
