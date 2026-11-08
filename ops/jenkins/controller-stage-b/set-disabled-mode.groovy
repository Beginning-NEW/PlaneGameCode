import hudson.slaves.EnvironmentVariablesNodeProperty
import jenkins.model.Jenkins

def controller = Jenkins.get()
def job = controller.getItemByFullName('plane-game/main-cd')
if (job == null) throw new IllegalStateException('fixed CD job is missing')
def properties = controller.getGlobalNodeProperties().getAll(EnvironmentVariablesNodeProperty.class)
if (properties.size() > 1) throw new IllegalStateException('global environment property is ambiguous')
def property = properties ? properties[0] : new EnvironmentVariablesNodeProperty()
if (!properties) controller.getGlobalNodeProperties().add(property)
property.getEnvVars().put('CD_TRIGGER_MODE', 'disabled')
job.makeDisabled(true)
controller.save()
job.save()
def verified = controller.getGlobalNodeProperties().getAll(EnvironmentVariablesNodeProperty.class)
if (verified.size() != 1 || verified[0].getEnvVars().get('CD_TRIGGER_MODE') != 'disabled' || !job.isDisabled()) {
  throw new IllegalStateException('disabled selector/job persistence verification failed')
}
println('selector=disabled')
println('job_disabled=true')
