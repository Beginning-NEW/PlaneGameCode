ARG JENKINS_BASE=jenkins/jenkins@sha256:74401de6a6f92e1afe1b02d1c8e3d0c33f263bfb5275dd8813f9150355f2367b
FROM ${JENKINS_BASE}

ARG CANDIDATE_SHA
LABEL org.opencontainers.image.revision=${CANDIDATE_SHA} \
      io.paperclip.plane-game.profile=jenkins-controller-stage-b \
      io.paperclip.plane-game.jenkins-core=2.580.2 \
      io.paperclip.plane-game.java=21

USER jenkins
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/plugins.install.txt /opt/plane-game-controller/plugins.install.txt
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/plugins.lock /opt/plane-game-controller/plugins.lock
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/plugins.sha256 /opt/plane-game-controller/plugins.sha256
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/verify-plugin-bundle.sh /opt/plane-game-controller/verify-plugin-bundle.sh
RUN jenkins-plugin-cli \
      --clean-download-directory \
      --plugin-file /opt/plane-game-controller/plugins.install.txt \
      --plugin-download-directory /usr/share/jenkins/ref/plugins \
    && bash /opt/plane-game-controller/verify-plugin-bundle.sh

COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/casc.yaml /usr/share/jenkins/ref/casc.yaml
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/init.groovy /usr/share/jenkins/ref/init.groovy.d/00-stage-b-invariants.groovy
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/plane-game-job.groovy /usr/share/jenkins/ref/jobs/plane-game-job.groovy
COPY --chown=jenkins:jenkins ops/jenkins/controller-stage-b/healthcheck.sh /opt/plane-game-controller/healthcheck.sh

ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/casc.yaml \
    CASC_STRICT_SECRET_RESOLUTION=true \
    JENKINS_OPTS="--httpListenAddress=0.0.0.0 --httpPort=8080" \
    JAVA_OPTS="-Djava.awt.headless=true -Djenkins.install.runSetupWizard=false -Dcasc.strict.secret.resolution=true -Djenkins.security.ApiTokenProperty.adminCanGenerateNewTokens=true -Xms128m -Xmx512m -XX:MaxMetaspaceSize=256m -XX:+ExitOnOutOfMemoryError" \
    MALLOC_ARENA_MAX=2

HEALTHCHECK --interval=10s --timeout=3s --start-period=90s --retries=12 \
  CMD ["/opt/plane-game-controller/healthcheck.sh"]
