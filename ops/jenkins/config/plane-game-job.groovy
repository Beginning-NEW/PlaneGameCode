// Auditable seed-job input. The generated job stays disabled until the separate
// Operations, security, QA, and CTO enablement gates are all approved.
pipelineJob('plane-game/main-cd') {
  description('Main-only CD from a completed trusted GitHub Actions Checks workflow_run.')
  disabled(true)
  parameters {
    stringParam('CANDIDATE_SHA', '', 'workflow_run.head_sha; treated as untrusted until API verification')
    stringParam('ACTIONS_RUN_ID', '', 'workflow_run.id; identity only, never release ordering')
    stringParam('ACTIONS_RUN_ATTEMPT', '', 'workflow_run.run_attempt; reruns never supersede an active run_number')
  }
  triggers {
    genericTrigger {
      genericHeaderVariables {
        genericHeaderVariable {
          key('X-GitHub-Event')
          regexpFilter('')
        }
      }
      genericVariables {
        genericVariable { key('ACTION'); value('$.action'); defaultValue('') }
        genericVariable { key('WORKFLOW_NAME'); value('$.workflow_run.name'); defaultValue('') }
        genericVariable { key('WORKFLOW_PATH'); value('$.workflow_run.path'); defaultValue('') }
        genericVariable { key('WORKFLOW_EVENT'); value('$.workflow_run.event'); defaultValue('') }
        genericVariable { key('WORKFLOW_STATUS'); value('$.workflow_run.status'); defaultValue('') }
        genericVariable { key('WORKFLOW_CONCLUSION'); value('$.workflow_run.conclusion'); defaultValue('') }
        genericVariable { key('HEAD_BRANCH'); value('$.workflow_run.head_branch'); defaultValue('') }
        genericVariable { key('HEAD_REPOSITORY'); value('$.workflow_run.head_repository.full_name'); defaultValue('') }
        genericVariable { key('REPOSITORY'); value('$.repository.full_name'); defaultValue('') }
        genericVariable { key('CANDIDATE_SHA'); value('$.workflow_run.head_sha'); defaultValue('') }
        genericVariable { key('ACTIONS_RUN_ID'); value('$.workflow_run.id'); defaultValue('') }
        genericVariable { key('ACTIONS_RUN_ATTEMPT'); value('$.workflow_run.run_attempt'); defaultValue('') }
      }
      regexpFilterText('$x_github_event|$ACTION|$WORKFLOW_NAME|$WORKFLOW_PATH|$REPOSITORY|$HEAD_REPOSITORY|$HEAD_BRANCH|$WORKFLOW_EVENT|$WORKFLOW_STATUS|$WORKFLOW_CONCLUSION|$CANDIDATE_SHA|$ACTIONS_RUN_ID|$ACTIONS_RUN_ATTEMPT')
      regexpFilterExpression('^workflow_run\\|completed\\|Checks\\|[.]github/workflows/checks[.]yml\\|Beginning-NEW/PlaneGameCode\\|Beginning-NEW/PlaneGameCode\\|main\\|push\\|completed\\|success\\|[0-9a-f]{40}\\|[1-9][0-9]*\\|[1-9][0-9]*$')
      causeString('Validated GitHub workflow_run handoff')
      printContributedVariables(false)
      printPostContent(false)
      silentResponse(true)
      shouldNotFlatten(true)
    }
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
