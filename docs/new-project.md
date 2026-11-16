# Working with a project, step by step

How a project goes from a Gitea repository to a running Positron session, and what to do day to day.
Setup of this repository itself (registry, `positron.env`, SSH) is in the [README](../README.md).

> **Current state:** everything below works with your local Docker (`--host local`).
> Running containers on stats2 needs host-level Docker access, which is not set up yet.

## Once per project: set it up

**1. Create the repository in Gitea** under the `stats` organization, as usual. Project code lives only in
Gitea; GitHub holds only the images and this repository.

**2. Choose the environment: add `container.env`** to the root of the repository, with one meaningful line:

```
ENV_IMAGE=ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7
```

This pins the project to an exact R version and package set. A year from now the project still opens with
the same versions, even if the shared image has moved on. Without this file the launcher uses
`DEFAULT_ENV_IMAGE` and shows a warning. A template is in
[project-template/container.env](../project-template/container.env).

**3. Only if the project needs packages that are not in `r-env`,** it gets a short Dockerfile: "take
`r-env:<tag>`, add packages X and Y" (template: [project-template/Dockerfile](../project-template/Dockerfile)).
The resulting project image then goes into `container.env` instead of `r-env`.

> **Open question:** the template workflow builds project images on GitHub, but project repositories live
> only on Gitea. Until this is settled, a project image is built on your Mac and pushed by hand. When the
> first project needs one, choose between Gitea Actions and adding the package to the shared `r-env`.

**4. Encrypted data** stays in the repository, encrypted with git-crypt. Your key lives only on your Mac
(`GIT_CRYPT_KEY_FILE` in `positron.env`), never in an image or in the repository.

## Every day: work

**5. Start the project:**

```bash
./run-positron.sh <project>             # the first reachable host from HOSTS (for now: your Mac)
./run-positron.sh <project> --unlock    # the same, plus decrypting the data inside the container
```

In order, the launcher:

1. reads `container.env` from Gitea;
2. gets the image: downloads it, or builds the Positron layer on the spot;
3. starts the container `positron-<project>`;
4. writes an SSH entry for it to `~/.ssh/positron/<project>.conf`;
5. clones or updates the project in `~/<project>` inside the container.

The first start takes a few minutes because of the downloads. After that it takes seconds.

**6. Connect from Positron:** Remote SSH → `positron-<project>` → folder `/home/analyst/<project>`.
From there it is normal work: R console, files, quarto.

**7. Commit and push to Gitea from inside the container,** as usual. Git uses your Mac's SSH keys, forwarded
through the connection, so nothing secret is stored in the container.

**8. Stop when done:**

```bash
./run-positron.sh <project> --stop
```

Your work stays in the project's volume and is there next time.

## Things that happen along the way

**Positron updated on your Mac.** Run step 5 again. The container is recreated with the matching server
version; your project folder and Positron extensions survive.

**You need a new package.**

- **To try it:** `install.packages()` inside the container works, but the package disappears when the
  container is recreated.
- **To keep it:** add it to the shared [env/renv.lock](../env/renv.lock), which produces a new `r-env` tag
  that projects switch to when ready. Or put it in the project's Dockerfile (step 3).

**Updating a project's environment** is a deliberate act: change the tag in `container.env`, commit, run
step 5. Other projects are not affected.

**Switching machines** (stats2 ↔ your Mac, once stats2 is set up):

1. Push everything on the old machine. `positron-projects status` inside the container shows what is not
   pushed yet.
2. Start the project on the other machine.

Git is the only bridge between machines: each machine's container has its own volume.

**Several projects at once.** Each has its own container, volume and SSH entry, so they do not interfere.
`./run-positron.sh --list` shows all project containers.

**What survives recreating a container:** only the project folder `~/<project>` and Positron's data and
extensions. Everything else in the home folder resets: R history, packages installed by hand, files
outside the project folder.

## Later (not built yet)

**9. Agents** work in the same `r-env` image, with a clone where the data stays encrypted. They write the
analysis code and open a pull request.

**10. CI** takes that pull request, decrypts the data with a secret key, renders the HTML, and sends you
the link. Since the code lives on Gitea, this runs in Gitea Actions (or a similar CI on your side), not on
GitHub.
