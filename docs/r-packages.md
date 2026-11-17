# R packages

Every R package a project uses is in its environment image. A container never downloads or builds packages, and a host needs no package repository. A project therefore works the same whatever the host's network allows, including no outside network at all (see [Images on hosts without registry access](#images-on-hosts-without-registry-access)).

## Where packages come from

1. **The team image `r-env`** ([env/Dockerfile](../env/Dockerfile), [env/renv.lock](../env/renv.lock)). The packages are installed into `/usr/local/lib/R/site-library` when the image is built, in CI with network access. They are the same in every container made from that digest and read-only for the `analyst` user.
2. **A derived image `r-env-<name>`** (optional), for projects that need packages `r-env` lacks: a published `r-env` digest plus the packages of `env/derived/<name>/extra.lock`. See [Derived images](#derived-images).

A project selects one of them by digest in `container.json`:

```json
{ "image": "ghcr.io/fnkc-stats/r-env@sha256:<digest>" }
```

Changing packages means a new image: change `env/renv.lock` (all projects, eventually) or a derived image's `extra.lock` (projects that pin it), let CI build and check it, then move projects to the new digest with a reviewed change of `container.json`, one at a time. Old digests stay usable until no project pins them.

## Derived images

A derived image only **adds** packages to a published `r-env`; it never changes a version `r-env` has. Every image built from the same `r-env` digest therefore has the team's packages at the same versions, and the R environment checks of `r-env` still hold for them.

- `env/derived/<name>/base`: one line, the `r-env` digest it is built on (`repository@sha256:...`).
- `env/derived/<name>/extra.lock`: the added packages and those of their dependencies the base lacks, with exact versions (renv lockfile format).
- [env/derived/Dockerfile](../env/derived/Dockerfile) installs them with renv from the base image's own repository setting (its CRAN snapshot), so they are built for the same R and system libraries. [verify.R](../env/verify.R) checks every version of both lockfiles and fails if `extra.lock` changes a version of the base.

To create or extend one, on a computer with Docker and network (not on the server):

```bash
env/derived/lock.sh survey-tools mice naniar   # writes env/derived/survey-tools/extra.lock (and base, if new)
```

`lock.sh` keeps packages already in `extra.lock`, skips packages the base already has, and records only what it had to add. Commit both files. The [derived images workflow](../.github/workflows/derived-image.yml) builds each derived image for the architectures its base has, verifies it, runs the [R environment checks](../checks/README.md) and the SSH tests, and on `main` publishes `ghcr.io/fnkc-stats/r-env-<name>` with the digest to pin in the run summary. Add that exact repository to the hosts' `allowedImages`.

To move a derived image to a new `r-env`, put the new digest into `base` and run `lock.sh <name>` again, so the added packages come from the new snapshot. A package that the new `r-env` has itself drops out of `extra.lock`.

## Images on hosts without registry access

Hosts do not need to reach the registry. When the pinned image is missing on a host, Open downloads it on the user's computer by its digest (registry HTTP API, no Docker needed there), keeps it in the client's cache, and sends it through the gateway. The host checks every manifest and layer against the pinned digest and the host's architecture before `docker load`. The digest fixes the content, not its publisher, so digest changes in `container.json` are reviewed like code (see [operations](operations.md#environment-images)). It is sent once per host and digest; later Opens use the host's copy. Details: [operations](operations.md#environment-images).

## Checking that packages fit together

A partial update can break packages that were left behind, even when everything installs. [checks/](../checks/README.md) checks an image's packages against each other and runs the team's common tasks on synthetic data. CI runs them for every image it builds; run `checks/run.sh <image>` by hand for any other image.

## Rules for analysts

- Packages come only from the image. `install.packages()` in a container installs into the home directory, which is lost when the container is recreated, and does not work at all on a host without network. Ask for the package to be added to `env/renv.lock` or to a derived image instead.
- Do not rely on a personal library (`~/R/...`).
- A project may keep a `renv.lock` as a record of what its code uses (`renv::snapshot()`), but it is not restored: the image's versions are the ones that run.
- After changing the image digest in `container.json`, stop and reopen the project.

## Local containers

Local runs (host `local`, Colima, Docker Desktop or WSL) use the same images. The local Docker pulls a missing image itself (`pullImages` is on for `local`); if that fails, the same download-and-load path is used. The image must match the computer's architecture: an Apple silicon Mac needs an arm64 (or multi-architecture) digest in `container.json`.
