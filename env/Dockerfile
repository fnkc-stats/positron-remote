# Environment image r-env: R, packages from renv.lock, quarto, git, git-crypt, sshd and the analyst user.
# The same image serves people (with the Positron layer on top, see positron/Dockerfile),
# CI (quarto render with decrypted data) and agents (without access to data).
#
# Built by GitHub Actions (.github/workflows/env-image.yml) and published as
# ghcr.io/<owner>/r-env:<date>-<commit>. Projects pin a specific tag in .devcontainer/devcontainer.json.
#
# Reproducibility: the R version is the rocker/r-ver tag (matches R in renv.lock), package versions
# come from renv.lock. Packages install as binaries from a Posit Package Manager snapshot of a date
# when every version in renv.lock was current (CRAN_SNAPSHOT); anything missing from the snapshot is
# built from source by renv. To update packages: replace renv.lock and R_VERSION, get CRAN_SNAPSHOT
# from env/snapshot-date.sh; a push builds a new tag. Old tags stay, and projects on them do not change.

ARG R_VERSION=4.5.1
FROM rocker/r-ver:${R_VERSION}

ARG CRAN_SNAPSHOT=2025-08-30
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
RUN /rocker_scripts/install_quarto.sh "${QUARTO_VERSION}"

# Packages from renv.lock go into the shared site-library that every R session sees.
# The lockfile's repository is replaced by a PPM snapshot with binary packages for the image's distro.
COPY renv.lock /tmp/renv.lock
# Working directory must not be /, otherwise renv treats the filesystem root as a project
WORKDIR /tmp
RUN codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
 && export RENV_CONFIG_REPOS_OVERRIDE="https://packagemanager.posit.co/cran/__linux__/${codename}/${CRAN_SNAPSHOT}" \
 && export RENV_CONFIG_CACHE_ENABLED=FALSE RENV_CONFIG_SANDBOX_ENABLED=FALSE \
 && Rscript -e 'install.packages("renv", repos = Sys.getenv("RENV_CONFIG_REPOS_OVERRIDE"))' \
 && Rscript -e 'renv::restore(lockfile = "/tmp/renv.lock", library = .libPaths()[1], prompt = FALSE)' \
 && Rscript -e 'ip <- installed.packages(); lock <- jsonlite::read_json("/tmp/renv.lock")$Packages; \
                bad <- Filter(function(p) !identical(unname(ip[p$Package, "Version"]), p$Version) && \
                              !(p$Package %in% rownames(ip)[ip[, "Priority"] %in% "recommended"]), lock); \
                if (length(bad)) stop("Versions do not match renv.lock: ", paste(sapply(bad, `[[`, "Package"), collapse = ", "))' \
 && echo "options(repos = c(CRAN = '${RENV_CONFIG_REPOS_OVERRIDE}'))" >> "${R_HOME}/etc/Rprofile.site" \
 && rm -rf /tmp/renv.lock /tmp/Rtmp* /root/.cache

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
LABEL org.opencontainers.image.title="r-env" \
      r-env.r-version="${R_VERSION}" \
      r-env.cran-snapshot="${CRAN_SNAPSHOT}" \
      r-env.quarto-version="${QUARTO_VERSION}"
