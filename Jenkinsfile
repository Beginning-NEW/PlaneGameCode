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
    string(name: 'CANDIDATE_SHA', defaultValue: '', description: 'workflow_run.head_sha')
    string(name: 'ACTIONS_RUN_ID', defaultValue: '', description: 'Completed Checks run id')
    string(name: 'ACTIONS_RUN_ATTEMPT', defaultValue: '', description: 'Completed Checks run attempt')
  }
  environment {
    GITHUB_REPOSITORY = 'Beginning-NEW/PlaneGameCode'
    IMAGE_REPOSITORY = 'ghcr.io/beginning-new/planegamecode'
  }
  stages {
    stage('Trusted main checkout') {
      steps {
        script {
          if (env.BRANCH_NAME != 'main' || env.CHANGE_ID) {
            error('CD is restricted to the trusted main job; PR jobs are forbidden')
          }
          if (!(params.CANDIDATE_SHA ==~ /[0-9a-f]{40}/) ||
              !(params.ACTIONS_RUN_ID ==~ /[1-9][0-9]*/) ||
              !(params.ACTIONS_RUN_ATTEMPT ==~ /[1-9][0-9]*/)) {
            error('Invalid workflow_run metadata')
          }
        }
        checkout scm
        sh '''
          set -eu
          case "$(git remote get-url origin)" in
            https://github.com/Beginning-NEW/PlaneGameCode.git|git@github.com:Beginning-NEW/PlaneGameCode.git) ;;
            *) echo 'Unexpected SCM repository' >&2; exit 1 ;;
          esac
          test "$(git rev-parse HEAD)" = "$CANDIDATE_SHA"
          git fetch --no-tags origin refs/heads/main
          test "$(git rev-parse FETCH_HEAD)" = "$CANDIDATE_SHA"
        '''
      }
    }
    stage('Serialized production CD') {
      steps {
        lock(resource: 'plane-game-production-cd', inversePrecedence: false) {
          withCredentials([string(credentialsId: 'plane-github-actions-read', variable: 'GH_API_TOKEN')]) {
            script {
              def verified = sh(
                script: 'bash ops/jenkins/verify-candidate.sh "$CANDIDATE_SHA" "$ACTIONS_RUN_ID" "$ACTIONS_RUN_ATTEMPT"',
                returnStdout: true
              ).trim().split('\\t') as List
              if (verified.size() != 3 || !(verified[0] ==~ /sha256:[0-9a-f]{64}/) ||
                  !(verified[1] ==~ /nginxinc\/nginx-unprivileged@sha256:[0-9a-f]{64}/) ||
                  !(verified[2] ==~ /[1-9][0-9]*/)) {
                error('Trusted Actions handoff returned invalid release metadata')
              }
              env.IMAGE_DIGEST = verified[0]
              env.GATEWAY_IMAGE = verified[1]
              env.ACTIONS_RUN_NUMBER = verified[2]
            }
          }
          sh 'bash ops/jenkins/resource-gate.sh'
          withCredentials([
            string(credentialsId: 'plane-github-actions-read', variable: 'GH_API_TOKEN'),
            usernamePassword(credentialsId: 'plane-ghcr-pull', usernameVariable: 'GHCR_USER', passwordVariable: 'GHCR_TOKEN')
          ]) {
            sh '''
              set -eu
              verified=$(bash ops/jenkins/verify-candidate.sh "$CANDIDATE_SHA" "$ACTIONS_RUN_ID" "$ACTIONS_RUN_ATTEMPT")
              expected=$(printf '%s\t%s\t%s' "$IMAGE_DIGEST" "$GATEWAY_IMAGE" "$ACTIONS_RUN_NUMBER")
              test "$verified" = "$expected"
              git fetch --no-tags origin refs/heads/main
              test "$(git rev-parse FETCH_HEAD)" = "$CANDIDATE_SHA"
              bash ops/jenkins/resource-gate.sh
              bash ops/jenkins/deploy-local.sh \
                "$CANDIDATE_SHA" "$IMAGE_REPOSITORY" "$IMAGE_DIGEST" "$DEPLOY_PORT" \
                "$ACTIONS_RUN_ID" "$GATEWAY_IMAGE"
            '''
          }
        }
      }
    }
  }
  post {
    always {
      echo "result=${currentBuild.currentResult} sha=${params.CANDIDATE_SHA} actions_run=${params.ACTIONS_RUN_ID}"
    }
  }
}
