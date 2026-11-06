// Auditable seed-job input. The generated job stays disabled until the separate
// Operations, security, QA, and CTO enablement gates are all approved.
pipelineJob('plane-game/main-cd') {
  description('Main-only CD queued only by the durable workflow_run admission gateway.')
  disabled(true)
  parameters {
    stringParam('CANDIDATE_SHA', '', 'workflow_run.head_sha; treated as untrusted until API verification')
    stringParam('ACTIONS_RUN_ID', '', 'workflow_run.id; identity only, never release ordering')
    stringParam('ACTIONS_RUN_ATTEMPT', '', 'workflow_run.run_attempt; reruns never supersede an active run_number')
    stringParam('WEBHOOK_DELIVERY', '', 'Validated X-GitHub-Delivery UUID; durable admission identity')
  }
  definition {
    cpsScm {
      scm {
        git {
          remote {
            url('https://github.com/Beginning-NEW/PlaneGameCode.git')
            credentials('plane-github-scm-read')
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
