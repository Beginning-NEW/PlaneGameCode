// Imported by JCasC. The job remains disabled until the separate enablement gate.
folder('plane-game') {
  authorization {
    userPermission('hudson.model.Item.Read', 'plane-webhook-gateway')
  }
}

pipelineJob('plane-game/main-cd') {
  description('Stage B main-only CD; disabled until controller, agent, gateway, QA, and security gates pass.')
  disabled(true)
  parameters {
    stringParam('CANDIDATE_SHA', '', 'workflow_run.head_sha; untrusted until API verification')
    stringParam('ACTIONS_RUN_ID', '', 'workflow_run.id; identity only')
    stringParam('ACTIONS_RUN_ATTEMPT', '', 'workflow_run.run_attempt')
    stringParam('WEBHOOK_DELIVERY', '', 'Validated X-GitHub-Delivery UUID')
  }
  authorization {
    userPermission('hudson.model.Item.Read', 'plane-webhook-gateway')
    userPermission('hudson.model.Item.Build', 'plane-webhook-gateway')
  }
  definition {
    cpsScm {
      scm {
        git {
          remote {
            url('https://github.com/Beginning-NEW/PlaneGameCode.git')
          }
          branch('*/main')
          extensions { cloneOptions { noTags(true); shallow(false) } }
        }
      }
      scriptPath('Jenkinsfile')
      lightweight(false)
    }
  }
}
