# An R environment image (env/Dockerfile) with the server of one Positron build: the image fnkc-ctl runs. One layer on
# top of the environment, so the environment's layers are shared, and the R part is bit for bit the image a project
# pins in container.json. Built in CI by positron.yml (for the team's Positron after every environment image, and on
# request by Build Environment for another one); locally by env/build.sh.
#
#   BASE: the environment image, pinned by digest (ghcr.io/fnkc-stats/r-env@sha256:...), or a local tag for tests
#   POSITRON_*: env/positron.args, or env/positron.sh --print <version>
ARG BASE
FROM ${BASE}
ARG BASE
ARG TARGETARCH
ARG POSITRON_VERSION
ARG POSITRON_COMMIT
ARG POSITRON_SHA256_AMD64
ARG POSITRON_SHA256_ARM64
ARG PROVENANCE_RUN=standard

# The server where Positron Remote SSH looks for it (~/.positron-server/bin/<commit>), so a container never downloads
# it. Owned by root: read-only for the session. Checked against the pinned checksums and commit. The Quarto it bundles
# (about 412 MB) is replaced by a link to the environment's pinned /opt/quarto (same layout), so the image carries one
# Quarto and the editor renders with the version the image's r-env.quarto-version label names.
RUN case "${TARGETARCH}" in \
      amd64) long=x86_64 short=x64 sum="${POSITRON_SHA256_AMD64}" ;; \
      arm64) long=arm64 short=arm64 sum="${POSITRON_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 5 -o /tmp/reh.tar.gz "https://cdn.posit.co/positron/releases/reh/${long}/positron-reh-linux-${short}-${POSITRON_VERSION}.tar.gz" \
 && printf '%s  /tmp/reh.tar.gz\n' "${sum}" > /tmp/reh.sha256 \
 && sha256sum -c /tmp/reh.sha256 \
 && dir="/home/analyst/.positron-server/bin/${POSITRON_COMMIT}" \
 && mkdir -p "$dir" \
 && tar -xzf /tmp/reh.tar.gz -C "$dir" --strip-components=1 --no-same-owner \
 && test -x "$dir/quarto/bin/quarto" && test -x /opt/quarto/bin/quarto \
 && rm -rf "$dir/quarto" && ln -s /opt/quarto "$dir/quarto" \
 && rm /tmp/reh.tar.gz /tmp/reh.sha256 \
 && grep -q "\"commit\": *\"${POSITRON_COMMIT}\"" "$dir/product.json" \
 && chown -R root:root /home/analyst/.positron-server/bin \
 && chmod -R a+rX,go-w /home/analyst/.positron-server/bin \
 && "$dir/bin/positron-server" --version \
 && "$dir/quarto/bin/quarto" --version

# r-env.base: the environment this image serves; fnkc-ctl runs it for projects whose container.json pins that image
LABEL positron.version="${POSITRON_VERSION}" \
      positron.commit="${POSITRON_COMMIT}" \
      r-env.base="${BASE}" \
      positron.provenance-run="${PROVENANCE_RUN}"
