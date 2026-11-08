// Main-only, same-host CD. GitHub Actions remains the only heavy CI and image publisher.
pipeline {
  agent { label 'plane-game-cd-rootless' }
  options {
    disableConcurrentBuilds(abortPrevious: false)
    skipDefaultCheckout(true)
    timestamps()
    timeout(time: 20, unit: 'MINUTES')
  }
  parameters {
    string(name: 'TRIGGER_SOURCE', defaultValue: '', description: 'poller or webhook; must match the reviewed global selector')
    string(name: 'GITHUB_SHA', defaultValue: '', description: 'Exact successful main push SHA')
    string(name: 'GITHUB_RUN_ID', defaultValue: '', description: 'Exact Actions run id')
    string(name: 'GITHUB_RUN_ATTEMPT', defaultValue: '', description: 'Exact Actions run attempt')
    string(name: 'TRIGGER_ID', defaultValue: '', description: 'Immutable trigger identity')
    string(name: 'WEBHOOK_DELIVERY_UUID', defaultValue: '', description: 'Webhook-only delivery UUID; empty in poller mode')
  }
  environment {
    GITHUB_REPOSITORY = 'Beginning-NEW/PlaneGameCode'
    IMAGE_REPOSITORY = 'ghcr.io/beginning-new/planegamecode'
    DEPLOY_PORT = '18081'
    PLANE_POLLER_STATE_DIR = '/home/plane-preflight/.local/state/plane-game-poller'
  }
  stages {
    stage('Trusted main checkout') {
      steps {
        script {
          if (env.JOB_NAME != 'plane-game/main-cd') {
            error('CD is restricted to the exact versioned main job')
          }
          if (!(env.CD_TRIGGER_MODE in ['disabled', 'poller', 'webhook']) ||
              env.CD_TRIGGER_MODE == 'disabled' || env.CD_TRIGGER_MODE != params.TRIGGER_SOURCE) {
            error('CD trigger selector is disabled, unknown, or mismatched')
          }
          def identityValid = params.GITHUB_SHA ==~ /[0-9a-f]{40}/ &&
            params.GITHUB_RUN_ID ==~ /[1-9][0-9]*/ &&
            params.GITHUB_RUN_ATTEMPT ==~ /[1-9][0-9]*/
          def webhookUuid = params.WEBHOOK_DELIVERY_UUID ==~ /(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/
          def pollerSchema = params.TRIGGER_SOURCE == 'poller' && identityValid &&
            params.TRIGGER_ID == "${params.GITHUB_SHA}:${params.GITHUB_RUN_ID}:${params.GITHUB_RUN_ATTEMPT}" &&
            params.WEBHOOK_DELIVERY_UUID == ''
          def webhookSchema = params.TRIGGER_SOURCE == 'webhook' && identityValid && webhookUuid &&
            params.TRIGGER_ID == "webhook:${params.WEBHOOK_DELIVERY_UUID}"
          if (!(pollerSchema || webhookSchema)) {
            error('Trigger parameters do not match one mutually exclusive schema')
          }
        }
        checkout scm
        sh '''
          set -eu
          case "$(git remote get-url origin)" in
            https://github.com/Beginning-NEW/PlaneGameCode.git) ;;
            *) echo 'Unexpected SCM repository' >&2; exit 1 ;;
          esac
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin refs/heads/main
          test "$(git rev-parse FETCH_HEAD)" = "$GITHUB_SHA"
        '''
      }
    }
    stage('Serialized production CD') {
      steps {
        lock(resource: 'plane-game-production-cd', inversePrecedence: false) {
          script {
            if (params.TRIGGER_SOURCE == 'poller') {
              def evidence = sh(
                script: 'flock --no-fork --nonblock "$PLANE_POLLER_STATE_DIR/.shared.lock" node ops/jenkins/jenkins-revalidate.mjs "$PLANE_POLLER_STATE_DIR" "$GITHUB_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"',
                returnStdout: true
              ).trim().split('\\t') as List
              if (evidence.size() != 6 || !(evidence[0] ==~ /[1-9][0-9]*/) ||
                  !(evidence[1] ==~ /[0-9a-f]{64}/) || evidence[2] != 'Beginning-NEW' ||
                  evidence[3] != '183624934' || !(evidence[5] ==~ /[1-9][0-9]*/)) {
                error('Private poller revalidation returned invalid evidence')
              }
              env.ACTIONS_RUN_NUMBER = evidence[0]
              env.GITHUB_EVIDENCE_HASH = evidence[1]
            } else {
              def verified = sh(
                script: 'bash ops/jenkins/verify-candidate.sh "$GITHUB_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT"',
                returnStdout: true
              ).trim().split('\\t') as List
              if (verified.size() != 4) error('Webhook public-source verification failed')
              env.IMAGE_DIGEST = verified[0]
              env.GATEWAY_IMAGE = verified[1]
              env.ACTIONS_RUN_NUMBER = verified[2]
            }
            if (params.TRIGGER_SOURCE == 'poller') {
              env.IMAGE_DIGEST = sh(
                script: 'bash ops/jenkins/resolve-public-ghcr-digest.sh "$GITHUB_REPOSITORY" "$GITHUB_SHA"',
                returnStdout: true
              ).trim()
              env.GATEWAY_IMAGE = sh(
                script: ". ops/jenkins/public-source-images.env; printf '%s' \"$GATEWAY_IMAGE\"",
                returnStdout: true
              ).trim()
            }
            if (!(env.IMAGE_DIGEST ==~ /sha256:[0-9a-f]{64}/) ||
                !(env.GATEWAY_IMAGE ==~ /nginxinc\/nginx-unprivileged@sha256:[0-9a-f]{64}/)) {
              error('Trusted public-source handoff returned invalid digest metadata')
            }
          }
          sh '''
            set -eu
            bash ops/jenkins/deploy-local.sh "$TRIGGER_SOURCE" "$PLANE_POLLER_STATE_DIR" \
              "$GITHUB_SHA" "$IMAGE_REPOSITORY" "$IMAGE_DIGEST" "$DEPLOY_PORT" \
              "$GITHUB_RUN_ID" "$ACTIONS_RUN_NUMBER" "$GITHUB_RUN_ATTEMPT" "$GATEWAY_IMAGE" \
              "ops/jenkins/resource-gate.sh"
          '''
        }
      }
    }
  }
  post {
    always {
      echo "result=${currentBuild.currentResult} source=${params.TRIGGER_SOURCE} sha=${params.GITHUB_SHA} actions_run=${params.GITHUB_RUN_ID} attempt=${params.GITHUB_RUN_ATTEMPT}"
    }
  }
}
