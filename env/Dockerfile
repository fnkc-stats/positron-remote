# The R environment of a series, without the Positron server: R, packages, tools, the analyst user and sshd. Project
# manifests pin its published digest. It is not run itself: env/positron.Dockerfile adds the server of one Positron
# build on top, and fnkc-ctl runs that image (the one for the user's Positron).
# CI verifies packages and renders a synthetic Quarto report before publication.
# One image per R series: the build arguments come from versions/<series>/build.args (env/build.sh passes them).
# The labels say what the image contains: R, its packages (the renv.lock checksum), Quarto.
ARG R_VERSION
ARG ROCKER_DIGEST
FROM rocker/r-ver:${R_VERSION}@${ROCKER_DIGEST}
ARG R_SERIES
ARG R_VERSION
ARG CRAN_SNAPSHOT
ARG QUARTO_VERSION=1.11.9
ARG TIDYVERSE_VERSION

# System packages:
#   git, git-crypt, gnupg, openssh-server: projects (git-crypt keys in GPG) and Positron Remote SSH;
#   zsh: the login shell;
#   *-dev, cmake: dependencies of R packages (curl, openssl, xml2, ragg, textshaping, systemfonts,
#   showtext, Cairo, igraph, V8, gert, ...); also needed for packages renv builds from source.
# No pandoc package: rmarkdown uses the pandoc Quarto ships (linked onto PATH below), about 200 MB less.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git git-crypt gnupg openssh-server zsh ca-certificates curl less nano procps \
      cmake \
      libcurl4-openssl-dev libssl-dev libxml2-dev libgit2-dev \
      libfontconfig1-dev libfreetype-dev libharfbuzz-dev libfribidi-dev \
      libpng-dev libtiff-dev libjpeg-dev libcairo2-dev libxt-dev \
      libglpk-dev libnode-dev \
 && rm -rf /var/lib/apt/lists/*

# Quarto (rocker script, installs the given version), and its pandoc for rmarkdown
RUN /rocker_scripts/install_quarto.sh "${QUARTO_VERSION}" \
 && pandoc="$(find /opt/quarto/bin/tools -name pandoc -type f -perm -u+x -print -quit)" \
 && test -n "$pandoc" \
 && ln -s "$pandoc" /usr/local/bin/pandoc \
 && pandoc --version

# Packages from renv.lock go into the shared site-library that every R session sees.
# The lockfile's repository is replaced by a PPM snapshot with binary packages for the image's distro.
# Only renv.lock comes before the restore: a change of the check scripts copied below must not reinstall every package.
COPY versions/${R_SERIES}/renv.lock /usr/local/share/r-env/
# Working directory must not be /, otherwise renv treats the filesystem root as a project
WORKDIR /tmp
RUN case "${R_VERSION}" in "${R_SERIES}".*) ;; *) echo "R ${R_VERSION} is not in series ${R_SERIES}" >&2; exit 1 ;; esac \
 && codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && export RENV_CONFIG_REPOS_OVERRIDE="https://packagemanager.posit.co/cran/__linux__/${codename}/${CRAN_SNAPSHOT}" \
 && export RENV_CONFIG_CACHE_ENABLED=FALSE RENV_CONFIG_SANDBOX_ENABLED=FALSE \
 && Rscript -e 'install.packages("renv", repos = Sys.getenv("RENV_CONFIG_REPOS_OVERRIDE"))' \
 && Rscript -e 'renv::restore(lockfile = "/usr/local/share/r-env/renv.lock", library = .libPaths()[1], prompt = FALSE)' \
 && echo "options(repos = c(CRAN = '${RENV_CONFIG_REPOS_OVERRIDE}'))" >> "${R_HOME}/etc/Rprofile.site" \
 && rm -rf /tmp/Rtmp* /root/.cache
# The checksum of renv.lock, for the r-env.lock-sha256 label: images with the same one have the same R packages
# (fnkc-ctl matches the environment built for another Positron by it). Checked against the copied file.
COPY verify.R smoke.qmd /usr/local/share/r-env/
ARG RENV_LOCK_SHA256
RUN chmod 644 /usr/local/share/r-env/* \
 && test "$(sha256sum /usr/local/share/r-env/renv.lock)" = "${RENV_LOCK_SHA256}  /usr/local/share/r-env/renv.lock" \
 && Rscript /usr/local/share/r-env/verify.R /usr/local/share/r-env/installed-packages.json \
 && test "$(quarto --version)" = "$QUARTO_VERSION" \
 && Rscript -e 'stopifnot(rmarkdown::pandoc_available("2.0"))' \
 && test "$(Rscript -e 'cat(as.character(packageVersion("tidyverse")))')" = "$TIDYVERSE_VERSION" \
 && sha256sum /usr/local/share/r-env/renv.lock > /usr/local/share/r-env/renv.lock.sha256


# Working user (uid 1000), with zsh. In ubuntu images uid 1000 is taken by the ubuntu user. An empty .zshrc keeps
# zsh's first-start questions out of terminals.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && useradd -m -u 1000 -U -s /bin/zsh analyst \
 && install -d -o analyst -g analyst /home/analyst/.ssh /home/analyst/.positron-server \
 && chmod 700 /home/analyst/.ssh \
 && install -o analyst -g analyst -m 644 /dev/null /home/analyst/.zshrc

# sshd: keys only, analyst only. Host keys are generated when a container starts, not in the image.
RUN rm -f /etc/ssh/ssh_host_* \
 && printf '%s\n' \
      'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowUsers analyst' 'AllowAgentForwarding yes' 'X11Forwarding no' \
      > /etc/ssh/sshd_config.d/positron.conf
# SSH sessions do not inherit the image's ENV: language and time zone for every login
RUN printf 'LANG=%s\nTZ=%s\n' "${LANG:-en_US.UTF-8}" "${TZ:-Etc/UTC}" >> /etc/environment

WORKDIR /home/analyst
# OCI labels: the source links the registry package to this repository; the revision is the commit it was built from
ARG SOURCE_REVISION=""
LABEL org.opencontainers.image.title="r-env" \
      org.opencontainers.image.description="R ${R_VERSION} environment for FNKC projects" \
      org.opencontainers.image.source="https://github.com/fnkc-stats/positron-remote" \
      org.opencontainers.image.version="${R_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      r-env.r-series="${R_SERIES}" \
      r-env.r-version="${R_VERSION}" \
      r-env.cran-snapshot="${CRAN_SNAPSHOT}" \
      r-env.quarto-version="${QUARTO_VERSION}" \
      r-env.tidyverse-version="${TIDYVERSE_VERSION}" \
      r-env.lock-sha256="${RENV_LOCK_SHA256}"
