# Образ окружения r-env: R, пакеты из renv.lock, quarto, git, git-crypt, sshd и пользователь analyst.
# Один и тот же образ используют люди (поверх него слой Positron, см. positron/Dockerfile),
# CI (quarto render с расшифрованными данными) и агенты (без доступа к данным).
#
# Собирается в GitHub Actions (.github/workflows/env-image.yml) и публикуется как
# ghcr.io/<owner>/r-env:<дата>-<commit>. Проекты фиксируют конкретный тег в container.env.
#
# Воспроизводимость: версия R — тег rocker/r-ver (совпадает с R в renv.lock), версии пакетов —
# renv.lock. Пакеты ставятся бинарными из снимка Posit Package Manager на дату, когда все версии
# из renv.lock были актуальны (CRAN_SNAPSHOT); чего нет в снимке, renv соберёт из исходников.
# Чтобы обновить пакеты: обновите renv.lock и R_VERSION, CRAN_SNAPSHOT подберёт env/snapshot-date.sh;
# новый тег соберётся при push;
# старые теги остаются, и проекты на них не меняются.

ARG R_VERSION=4.5.1
FROM rocker/r-ver:${R_VERSION}

ARG CRAN_SNAPSHOT=2025-08-30
ARG QUARTO_VERSION=1.11.9

# Системные пакеты:
#   git, git-crypt, openssh-server — проекты и Positron Remote SSH;
#   *-dev, cmake — зависимости R-пакетов (curl, openssl, xml2, ragg, textshaping, systemfonts,
#   showtext, Cairo, igraph, V8, gert и др.); нужны и для пакетов, которые renv соберёт из исходников;
#   pandoc — для rmarkdown (quarto несёт свой pandoc, но не в PATH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-crypt openssh-server ca-certificates curl less nano procps \
      cmake pandoc \
      libcurl4-openssl-dev libssl-dev libxml2-dev libgit2-dev \
      libfontconfig1-dev libfreetype-dev libharfbuzz-dev libfribidi-dev \
      libpng-dev libtiff-dev libjpeg-dev libcairo2-dev libxt-dev \
      libglpk-dev libnode-dev \
 && rm -rf /var/lib/apt/lists/*

# Quarto (скрипт из rocker, ставит указанную версию)
RUN /rocker_scripts/install_quarto.sh "${QUARTO_VERSION}"

# Пакеты из renv.lock — в общую библиотеку site-library, видимую любому сеансу R.
# Репозиторий из lock-файла заменяется снимком PPM с бинарными пакетами для дистрибутива образа.
COPY renv.lock /tmp/renv.lock
# Рабочий каталог не /, иначе renv считает корень файловой системы проектом
WORKDIR /tmp
RUN codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && export RENV_CONFIG_REPOS_OVERRIDE="https://packagemanager.posit.co/cran/__linux__/${codename}/${CRAN_SNAPSHOT}" \
 && export RENV_CONFIG_CACHE_ENABLED=FALSE RENV_CONFIG_SANDBOX_ENABLED=FALSE \
 && Rscript -e 'install.packages("renv", repos = Sys.getenv("RENV_CONFIG_REPOS_OVERRIDE"))' \
 && Rscript -e 'renv::restore(lockfile = "/tmp/renv.lock", library = .libPaths()[1], prompt = FALSE)' \
 && Rscript -e 'ip <- installed.packages(); lock <- jsonlite::read_json("/tmp/renv.lock")$Packages; \
                bad <- Filter(function(p) !identical(unname(ip[p$Package, "Version"]), p$Version) && \
                              !(p$Package %in% rownames(ip)[ip[, "Priority"] %in% "recommended"]), lock); \
                if (length(bad)) stop("Не совпали версии: ", paste(sapply(bad, `[[`, "Package"), collapse = ", "))' \
 && echo "options(repos = c(CRAN = '${RENV_CONFIG_REPOS_OVERRIDE}'))" >> "${R_HOME}/etc/Rprofile.site" \
 && rm -rf /tmp/renv.lock /tmp/Rtmp* /root/.cache

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
