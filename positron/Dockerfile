# Слой Positron поверх образа окружения (r-env или образа проекта).
#
# Здесь нет RUN и сетевых обращений, только ADD: архив сервера скачивает и раскладывает build-image.sh.
# Поэтому слой собирается на любом демоне, в том числе на закрытом stats2 и на arm64 Mac, без эмуляции.
# Пользователь analyst, sshd, git уже есть в образе окружения (env/Dockerfile).
#
# Контекст сборки (готовит build-image.sh):
#   server.tar.gz         ./bin/<commit>/..., ./data, ./extensions -> /home/analyst/.positron-server
#                         (владелец analyst уже записан в заголовках архива)
#   positron-entrypoint   ключ SSH из $SSH_PUBLIC_KEY, ключи хоста, запуск sshd
#   positron-projects     клонирование / обновление проекта из Gitea или GitHub

ARG ENV_IMAGE
# Тег приходит в ENV_IMAGE (build-image.sh проверяет, что он задан и не latest)
# hadolint ignore=DL3006
FROM ${ENV_IMAGE}

ARG ENV_IMAGE
ARG POSITRON_VERSION
ARG POSITRON_COMMIT

# Positron Remote SSH ищет сервер в ~/.positron-server/bin/<commit>/bin/positron-server.
# ADD (а не COPY) нужен, чтобы распаковать архив.
ADD server.tar.gz /home/analyst/.positron-server/
COPY positron-entrypoint positron-projects /usr/local/bin/

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/positron-entrypoint"]

LABEL org.opencontainers.image.title="positron" \
      positron.version="${POSITRON_VERSION}" \
      positron.commit="${POSITRON_COMMIT}" \
      positron.env-image="${ENV_IMAGE}"
