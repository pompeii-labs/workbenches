# The Workbench arm's machine: the same bare environment as the plain arm, plus the
# wb engine. Product packages bring their own Dockerfiles and never inherit this image.
ARG AGENT_IMAGE=workbenchmark-agent:dev
FROM ${AGENT_IMAGE}
USER root
COPY wb /usr/local/bin/wb
RUN mkdir -p /usr/local/libexec && mv /usr/local/bin/docker /usr/local/libexec/docker-real
COPY docker-policy.sh /usr/local/bin/docker
RUN chmod 0755 /usr/local/bin/wb /usr/local/bin/docker && wb --version
USER node
