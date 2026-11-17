# Immutable R environment; project manifests pin the published image digest. Two images:
#   r-base (--target base): R, the system libraries R packages need, compilers, Quarto, git, sshd; no R packages
#     beyond R's own. Projects that pin a "library" in container.json get their packages from a library volume
#     on the host, built from a lockfile for this image (positron-ctl admin build-library).
#   r-env (the last stage): r-base with the packages of renv.lock installed.
# CI verifies packages and renders a synthetic Quarto report before publication.
ARG R_VERSION=4.5.1
FROM rocker/r-ver:${R_VERSION}@sha256:03b023fbf7b1b24ac1bb8b2ac5fd7e15a767e67b40ff50c155e328110981c2aa AS base
ARG R_VERSION
ARG QUARTO_VERSION=1.11.9

# System packages:
#   git, git-crypt, openssh-server: projects and Positron Remote SSH;
#   *-dev, cmake: dependencies of R packages (curl, openssl, xml2, ragg, textshaping, systemfonts,
#   showtext, Cairo, igraph, V8, gert, ...); also needed for packages renv builds from source;
#   pandoc: for rmarkdown (quarto ships its own pandoc, but not on PATH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-crypt openssh-server ca-certificates curl less nano procps \
      cmake pandoc \
      libcurl4-openssl-dev libssl-dev libxml2-dev libgit2-dev \
      libfontconfig1-dev libfreetype-dev libharfbuzz-dev libfribidi-dev \
      libpng-dev libtiff-dev libjpeg-dev libcairo2-dev libxt-dev \
      libglpk-dev libnode-dev \
 && rm -rf /var/lib/apt/lists/*

# Quarto (rocker script, installs the given version)
RUN /rocker_scripts/install_quarto.sh "${QUARTO_VERSION}" \
 && test "$(quarto --version)" = "$QUARTO_VERSION"

# Working user (uid 1000). In ubuntu images uid 1000 is taken by the ubuntu user.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -u 1000 -U -s /bin/bash analyst \
 && install -d -o analyst -g analyst /home/analyst/.ssh \
 && chmod 700 /home/analyst/.ssh

# sshd: keys only, analyst only. Host keys are generated when a container starts, not in the image.
RUN rm -f /etc/ssh/ssh_host_* \
 && printf '%s\n' \
      'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowUsers analyst' 'AllowAgentForwarding yes' 'X11Forwarding no' \
      > /etc/ssh/sshd_config.d/positron.conf
# SSH sessions do not inherit the image's ENV: language and time zone for every login
RUN printf 'LANG=%s\nTZ=%s\n' "${LANG:-en_US.UTF-8}" "${TZ:-Etc/UTC}" >> /etc/environment

WORKDIR /home/analyst
LABEL org.opencontainers.image.title="r-base" \
      r-env.r-version="${R_VERSION}" \
      r-env.quarto-version="${QUARTO_VERSION}"

FROM base AS r-env
ARG CRAN_SNAPSHOT=2025-08-30
# Packages from renv.lock go into the shared site-library that every R session sees.
# The lockfile's repository is replaced by a PPM snapshot with binary packages for the image's distro.
COPY renv.lock verify.R /usr/local/share/r-env/
COPY smoke.qmd /usr/local/share/r-env/smoke.qmd
# Working directory must not be /, otherwise renv treats the filesystem root as a project
WORKDIR /tmp
RUN codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && export RENV_CONFIG_REPOS_OVERRIDE="https://packagemanager.posit.co/cran/__linux__/${codename}/${CRAN_SNAPSHOT}" \
 && export RENV_CONFIG_CACHE_ENABLED=FALSE RENV_CONFIG_SANDBOX_ENABLED=FALSE \
 && Rscript -e 'install.packages("renv", repos = Sys.getenv("RENV_CONFIG_REPOS_OVERRIDE"))' \
 && Rscript -e 'renv::restore(lockfile = "/usr/local/share/r-env/renv.lock", library = .libPaths()[1], prompt = FALSE)' \
 && echo "options(repos = c(CRAN = '${RENV_CONFIG_REPOS_OVERRIDE}'))" >> "${R_HOME}/etc/Rprofile.site" \
 && rm -rf /tmp/Rtmp* /root/.cache
RUN chmod 644 /usr/local/share/r-env/* \
 && Rscript /usr/local/share/r-env/verify.R /usr/local/share/r-env/installed-packages.json \
 && sha256sum /usr/local/share/r-env/renv.lock > /usr/local/share/r-env/renv.lock.sha256
WORKDIR /home/analyst
LABEL org.opencontainers.image.title="r-env" \
      r-env.cran-snapshot="${CRAN_SNAPSHOT}"

