# R packages and renv

This document records how R packages reach a project container and how projects use renv. The behaviour is implemented in [Rprofile.R](../ctl/container/Rprofile.R), [entrypoint.sh](../ctl/container/entrypoint.sh) and, for libraries on the host, [library.ts](../ctl/src/library.ts) and [build-library.R](../ctl/container/build-library.R).

## Sources of packages

1. **The team's packages** (`env/renv.lock`), in one of two forms. `container.json` decides which one:
   - **In the image** (`r-env`; `container.json` has only `"image"`). The packages are installed into `/usr/local/lib/R/site-library` when the image is built. They are the same in every container made from that digest.
   - **In a library on the host** (`r-base`, plus `"library"` in `container.json`). The image has R, the system libraries, the compilers and Quarto, but no packages. The packages are in a library volume on the host, built from the lockfile for exactly this image, and mounted at `/usr/local/lib/R/site-library`. See [Libraries on the host](#libraries-on-the-host).

   Either way they are read-only for the `analyst` user and cannot be changed from inside a container.
2. **The project's own `renv.lock` (optional).** A project that commits a `renv.lock` at its root gets its own library, `<project>/renv/library`, on the project volume. It works the same on top of either form.

A project without `renv.lock` uses only the team's packages. Adding packages to such a project means changing `env/renv.lock` and publishing a new image or building a new library, or adding a `renv.lock` to the project.

## Libraries on the host

With a library, a package update doesn't need a new image: the image changes only when R, the system libraries or Quarto do. The server gets the small `r-base` image once (656 MB compressed instead of 933 MB) and builds each library itself, from CRAN source.

```json
{
  "image": "ghcr.io/fnkc-stats/r-base@sha256:<digest>",
  "library": "sha256:<sha256 of the renv.lock the library was built from>"
}
```

- **Building.** An administrator runs `sudo positron-ctl admin build-library <image> <renv.lock>` on the server; on your own computer, `positron-ctl build-library <image> <renv.lock>`. The command:
  - pulls the image;
  - builds every locked package from source in a helper container from that image, so the binaries link against exactly its system libraries;
  - runs the [R environment checks](../checks/README.md) with the library mounted as projects see it;
  - only then marks the library ready, and prints the `"library"` value for `container.json`.

  On a 6-CPU machine the full `env/renv.lock` (257 packages beyond R's own) took 23 minutes: about 13 minutes to look up and download the locked versions, 8.5 minutes to compile, as renv builds several packages at once. Other projects keep starting meanwhile. An interrupted build continues where it stopped when you run the command again. Options: `--jobs <n>` (default: all CPUs), `--skip-checks` (marks the library ready without the checks; not for production).
- **No pak.** pak as renv's installer was tried (2026-11-17) and could not resolve the lockfile: given exact older versions, its solver reported dependency conflicts for most packages, including R's own. renv alone already installs in parallel, so pak would add little.
- **Never changed.** A ready library is never modified. An update is a new lockfile, so a new library: projects move to it with a reviewed change of `container.json`, one project at a time, and old libraries stay until no project needs them. `positron-ctl admin libraries` lists them.
- **Tied to the image.** The volume's name holds the image's ID and the lockfile's hash: `positron-rlib-<image ID>-<lockfile hash>`, both shortened to 16 digits; volume labels hold them in full. A library built for another image or architecture is never mounted. A new image (newer system libraries) needs a new library build, even with the same lockfile.
- **At start.** If the pinned library isn't ready on the host, Open stops and says how to build it. Nothing is created and nothing is downloaded during Open. The container gets the library read-only at `/usr/local/lib/R/site-library` and `POSITRON_LIBRARY` set to its value. A project's own `renv.lock` keeps working: the library is renv's external library, as the image's packages are.
- **Checked in CI.** The [r checks workflow](../.github/workflows/r-checks.yml) builds the base image and the library from `env/renv.lock` with the same script and runs the checks, whenever `env/` changes. The server's own build and checks are the final word, because that is where the binaries are used.
- **Reviewed real-data reports** ([render-reviewed.py](../ctl/server/render-reviewed.py)): an approval for a commit whose `container.json` pins a library must name the same `"library"`, and the runner mounts that library only if it is ready there.
- **Where packages come from.** The host's `rRepository` (CRAN by default). For locked versions that are no longer current, renv looks them up on `crandb.r-pkg.org` and downloads them from CRAN's archive. The host should reach both.

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

## Checking that packages fit together

A partial update can break packages that were left behind, even when everything installs. [checks/](../checks/README.md) checks an image's packages against each other and runs the team's common tasks on synthetic data. Run `checks/run.sh <image>` before pinning a new image in projects.

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
