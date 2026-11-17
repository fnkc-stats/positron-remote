# R packages and renv

This document records how R packages reach a project container and how projects use renv. The behaviour is implemented in [Rprofile.R](../ctl/container/Rprofile.R) and [entrypoint.sh](../ctl/container/entrypoint.sh).

## Two sources of packages

1. **The image.** `env/renv.lock` is installed into the image at build time, into `/usr/local/lib/R/site-library`. Each project pins the image by digest in `container.json`. These packages are the same in every container made from that digest. They are read-only for the `analyst` user and cannot be changed from inside a container.
2. **The project's own `renv.lock` (optional).** A project that commits a `renv.lock` at its root gets its own library, `<project>/renv/library`, on the project volume.

A project without `renv.lock` uses only the image's packages. Adding packages to such a project means changing `env/renv.lock` and publishing a new image (see the README), or adding a `renv.lock` to the project.

## What happens at container start

- The first interactive R console after each container start runs `renv::restore()` for the project's `renv.lock`. Later consoles in the same container run do not repeat it. Non-interactive R (`Rscript`, `quarto render`) never restores.
- The restore installs into `<project>/renv/library`. This library is on the project volume, so it survives Stop, restart and recreation of the container. Later restores only check it against the lockfile.
- renv's one-time consent question is answered in advance (`options(renv.consent = TRUE)`), so it cannot take over the console.
- A project that has only `renv.lock` gets a `renv/.gitignore` (the same one `renv::init()` writes), so the library never shows up in Git.
- If the restore fails, the console shows the error. It is not retried until the next container start: fix the cause and run `renv::restore()` by hand.

## How package versions are chosen

- The image's site library stays visible to renv projects as an external library. `.libPaths()` is, in order: the project library, `/usr/local/lib/R/site-library`, base R.
- A locked package whose exact version is already in the image is used from the image. It is not downloaded or copied into the project.
- A locked package with a different version, or one the image lacks, is installed into the project library. That library comes first, so **the lockfile's version always wins** over the image.
- Packages the image does not provide are downloaded once per server, not once per project or user: they are kept in the server's shared renv cache (below), and the project library links to them.
- Packages that are in the image but not in the lockfile can still be loaded. Code may therefore depend on them silently. Run `renv::snapshot()` before committing, so the lockfile records every package the code uses.

## Rules for analysts

- Install packages only inside a project with `renv.lock`, with `renv::install()` (or `install.packages()`), then `renv::snapshot()` and commit `renv.lock`. An install that is not snapshotted works only in your container and is not shared.
- Do not rely on a personal library (`~/R/...`). The home directory, apart from the project folder, is lost when the container is recreated.
- Commit `renv.lock` (and `renv/activate.R`, `.Rprofile` and `renv/settings.json` if renv created them). Never commit `renv/library`. renv's own `renv/.gitignore` excludes it.
- After changing the image digest in `container.json`, reopen the project. Packages that the new image provides at the locked version are then taken from it; the project library keeps only the rest.

## Shared renv cache

- Each server has one Docker volume, `positron-renv-cache`, mounted at `/var/cache/positron-renv` in every project container of every user. renv keeps platforms, R versions and architectures apart inside it.
- The first project that needs a package version downloads it into the cache. Every later project on that server, of any user, links to the cached copy.
- The image's own packages are never copied into the cache; they are used from the image.
- **Trust:** every user's container can write to the cache, so one user can change package files that another user's R loads. This fits the rule that project containers run trusted team code. A team that does not trust each other must set `"sharedRenvCache": false` in `/etc/positron-ctl/agent.json`. Each project then keeps its own copies.
- **Cleanup** is an administrator task. Removing the volume (`docker volume rm positron-renv-cache`, only while no project container uses it) leaves project libraries with broken links. The next automatic restore at container start downloads the missing packages again. Inside a container, `renv::purge()` removes single packages from the cache, for all users.
- Changing `sharedRenvCache` changes every container's setup: running containers report "environment update pending" and are recreated after Stop and reopen.

## Where packages are downloaded from

The server has no access to Posit. Packages that are not in the image come from the host's `rRepository` (`/etc/positron-ctl/agent.json`, or the `local` section of the personal config for local runs). The default is the CRAN cloud mirror. A Posit URL in a lockfile's `Repositories` is ignored for installation; renv only takes package names and versions from the lockfile. Building from source takes longer the first time (minutes for large packages), but thanks to the shared cache it happens once per server.

## Local containers

Local runs (host `local`, Colima, Docker Desktop or WSL) work the same way. The local Docker gets its own `positron-renv-cache` volume, shared by the projects on that computer. Set `"sharedRenvCache": false` in the `local` section of `~/.config/positron-ctl/config.json` to give each project its own copies instead. The image must match the computer's architecture: an Apple silicon Mac needs an arm64 (or multi-architecture) image digest in `container.json`.

## Settings the container applies to renv projects

| Setting | Value | Why |
|---|---|---|
| `RENV_PATHS_CACHE` | `/var/cache/positron-renv` (only with the shared cache) | One cache per server, kept on a volume. |
| `RENV_CONFIG_CACHE_ENABLED` | `TRUE` with the shared cache, otherwise `FALSE` | renv's default cache is in the home directory, which is lost on recreation and would leave the project library with broken links. Without the shared cache, packages are stored as real copies in the project library. |
| `RENV_CONFIG_EXTERNAL_LIBRARIES` | `/usr/local/lib/R/site-library` | Reuse the image's packages instead of downloading them again. |
| `RENV_CONFIG_REPOS_OVERRIDE` and `options(repos)` | the host's `rRepository` (default `https://cloud.r-project.org`) | The server has no access to Posit, so neither the image's Posit Package Manager snapshot nor a Posit URL in a lockfile can be used. CRAN packages for Linux are built from source; the image has the compilers and libraries for that. |

Each renv value is set only if it is not already set, so a project or administrator can override it. `options(repos)` always follows `rRepository`. On a computer that can reach Posit (for example for local runs), set `rRepository` to a Posit Package Manager binary URL such as `https://packagemanager.posit.co/cran/__linux__/noble/latest` for faster installs.
