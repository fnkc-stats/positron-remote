# Образ окружения r-env: R, пакеты, quarto, git, git-crypt, sshd и пользователь analyst.
# Один и тот же образ используют люди (поверх него слой Positron, см. positron/Dockerfile),
# CI (quarto render с расшифрованными данными) и агенты (без доступа к данным).
#
# Собирается в GitHub Actions (.github/workflows/env-image.yml) и публикуется как
# ghcr.io/<owner>/r-env:<дата>-<commit>. Проекты фиксируют конкретный тег в container.env.
#
# Воспроизводимость: версия R задаётся тегом rocker/r-ver, версии пакетов — датой снимка CRAN
# в Posit Package Manager. Чтобы обновить пакеты, поменяйте CRAN_SNAPSHOT и соберите новый тег;
# старые теги остаются, и проекты на них не меняются.

ARG R_VERSION=4.6.1
FROM rocker/r-ver:${R_VERSION}

ARG CRAN_SNAPSHOT=2026-11-01
ARG QUARTO_VERSION=1.11.9

# Системные пакеты: git и git-crypt для проектов, openssh-server для Positron Remote SSH
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-crypt openssh-server ca-certificates curl less nano procps \
 && rm -rf /var/lib/apt/lists/*

# Quarto (скрипт из rocker, ставит указанную версию)
RUN QUARTO_VERSION="${QUARTO_VERSION}" /rocker_scripts/install_quarto.sh

# Снимок CRAN на дату: бинарные пакеты Posit Package Manager для дистрибутива образа
RUN codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && echo "options(repos = c(CRAN = 'https://packagemanager.posit.co/cran/__linux__/${codename}/${CRAN_SNAPSHOT}'))" \
      >> "${R_HOME}/etc/Rprofile.site"

# Общие пакеты. pak сам ставит нужные системные библиотеки.
COPY packages.txt /tmp/packages.txt
RUN Rscript -e 'install.packages("pak")' \
 && Rscript -e 'p <- trimws(sub("#.*", "", readLines("/tmp/packages.txt"))); p <- p[nzchar(p)]; \
                pak::pkg_install(p, ask = FALSE); pak::cache_clean()' \
 && rm -rf /tmp/packages.txt /tmp/Rtmp* /root/.cache

# Пользователь для работы (uid 1000). В ubuntu-образах uid 1000 занят пользователем ubuntu.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -u 1000 -U -s /bin/bash analyst \
 && install -d -o analyst -g analyst /home/analyst/work /home/analyst/.ssh \
 && chmod 700 /home/analyst/.ssh

# sshd: только ключи, только analyst. Ключи хоста генерируются при старте контейнера, не в образе.
RUN rm -f /etc/ssh/ssh_host_* \
 && printf '%s\n' \
      'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowUsers analyst' 'AllowAgentForwarding yes' 'X11Forwarding no' \
      > /etc/ssh/sshd_config.d/positron.conf
# SSH-сессии не наследуют ENV образа: язык и часовой пояс для всех входов
RUN printf 'LANG=%s\nTZ=%s\n' "${LANG:-en_US.UTF-8}" "${TZ:-Etc/UTC}" >> /etc/environment

WORKDIR /home/analyst/work
LABEL org.opencontainers.image.title="r-env" \
      r-env.r-version="${R_VERSION}" \
      r-env.cran-snapshot="${CRAN_SNAPSHOT}" \
      r-env.quarto-version="${QUARTO_VERSION}"
