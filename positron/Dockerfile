# Positron layer on top of an environment image (r-env or a project image).
#
# No RUN and no network access here, only ADD/COPY: build-image.sh downloads and lays out the server archive.
# So the layer builds on any daemon, including a server without internet access and an arm64 Mac, without emulation.
# The analyst user, sshd and git already come with the environment image (env/Dockerfile).
#
# Build context (prepared by build-image.sh):
#   server.tar.gz         ./bin/<commit>/..., ./data, ./extensions -> /home/analyst/.positron-server
#                         (owner analyst is already recorded in the archive headers)
#   positron-entrypoint   SSH key from $SSH_PUBLIC_KEY, host keys, starts sshd
#   positron-projects     clones / updates the project from Gitea

ARG ENV_IMAGE
# The tag comes in ENV_IMAGE (build-image.sh checks that it is set and not latest)
# hadolint ignore=DL3006
FROM ${ENV_IMAGE}

ARG ENV_IMAGE
ARG POSITRON_VERSION
ARG POSITRON_COMMIT

# Positron Remote SSH looks for the server in ~/.positron-server/bin/<commit>/bin/positron-server.
# ADD (not COPY) is needed to unpack the archive.
ADD server.tar.gz /home/analyst/.positron-server/
COPY positron-entrypoint positron-projects /usr/local/bin/

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/positron-entrypoint"]

LABEL org.opencontainers.image.title="positron" \
      positron.version="${POSITRON_VERSION}" \
      positron.commit="${POSITRON_COMMIT}" \
      positron.env-image="${ENV_IMAGE}"
