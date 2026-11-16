# Working with a project, step by step

How a project goes from a Gitea repository to a running Positron session, and what to do day to day.
The main way is **Dev Containers in Positron**: no terminal, no scripts. Setting up your machine once is
described in the [README](../README.md#настройка-рабочего-места-для-всех).

## Once per project: set it up

**1. Create the repository in Gitea** under the `stats` organization, from the project template.
Project code lives only in Gitea; GitHub holds only the images and the `positron-remote` repository.

**2. The template brings `.devcontainer/devcontainer.json`.** Its `"image"` line pins the project to an exact
R version and package set:

```json
{
  "name": "R (fnkc-stats r-env)",
  "image": "ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7",
  "remoteUser": "analyst"
}
```

A year from now the project still opens with the same versions, even if the shared image has moved on.
The file to put into the Gitea template is
[project-template/.devcontainer/devcontainer.json](../project-template/.devcontainer/devcontainer.json).

**3. Only if the project needs packages that are not in `r-env`:** add a Dockerfile next to
`devcontainer.json` and switch `"image"` to `"build"`. The steps are in
[Dockerfile.example](../project-template/.devcontainer/Dockerfile.example). Positron builds the project
image on your machine when it opens the project; nothing is published anywhere.

**4. Encrypted data** stays in the repository, encrypted with git-crypt. The key lives only with people,
never in an image or in the repository.

## Every day: work

**5. Get the project onto your machine (once):** in Positron, *Clone Git Repository*, with the SSH address
from Gitea's Clone button (`ssh://git@…:2221/stats/<project>.git`). Or `git clone` in a terminal.

**6. Open the project folder in Positron.** Positron notices `.devcontainer/devcontainer.json` and offers
**Reopen in Container**. Click it. The first time takes a few minutes: the image (about 1 GB) is
downloaded and Positron installs its server part into the container. After that it takes seconds.

You are now working inside the container: R console, files, quarto, all with the project's pinned
environment. The project folder is your normal folder on your machine, mounted into the container, so
files are never "inside" the container only.

**7. Decrypting the data (projects with git-crypt):** run once in the project folder on your machine
(`brew install git-crypt` first):

```bash
git-crypt unlock /path/to/project.key
```

The container sees the decrypted files immediately, because it is the same folder.

**8. Commit and push to Gitea** as usual, from Positron's Git panel or a terminal.

**9. Done for the day:** just close the window. The container stops; your files are in the project folder
as always.

## Things that happen along the way

**Positron updated.** Nothing to do: Positron installs its matching server into the container on the next
*Reopen in Container*.

**You need a new package.**

- **To try it:** `install.packages()` inside the container works, but the package disappears when the
  container is rebuilt.
- **To keep it:** add it to the project's Dockerfile (step 3), or, if many projects need it, to the shared
  [env/renv.lock](../env/renv.lock), which produces a new `r-env` tag.

**Updating a project's environment** is a deliberate act: change the `"image"` tag in
`devcontainer.json`, commit, then *Dev Containers: Rebuild and Reopen in Container*. Other projects are not
affected.

**Several projects at once.** Each project gets its own container, so they do not interfere.

**Working on another computer.** Push everything, clone the project there, step 6. Git is the only bridge
between machines.

## Running a project on a server

Dev containers cannot be opened through Remote SSH. To run a project on a server, use `run-positron.sh`
from the `positron-remote` repository: it starts the project's container on the server, clones the
project there, and Positron connects to it with Remote SSH. See the README section
[run-positron.sh](../README.md#run-positronsh). It reads the same `"image"` line from the project's
`devcontainer.json`.

## Not verified yet

Dev containers in Positron are a preview feature. To check on the first real project:

- whether `git push` from inside the container uses your machine's SSH key (otherwise push from a terminal
  on your machine: it is the same folder);
- with Colima, whether setting `dev.containers.dockerSocketPath` to `~/.colima/default/docker.sock` is enough.

## Later (not built yet)

**Agents** work in the same `r-env` image, with a clone where the data stays encrypted. They write the
analysis code and open a pull request.

**CI** takes that pull request, decrypts the data with a secret key, renders the HTML, and sends you the link.
Since the code lives on Gitea, this runs in Gitea Actions (or a similar CI on our side).
