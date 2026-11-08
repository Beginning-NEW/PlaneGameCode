# Stage B disable, backup, restore, and rollback

The package is staged disabled. The controller run script, gateway user service, job DSL, and webhook remain inactive until separate Operations, security, QA, and CTO gates approve an enablement change.

## Deterministic disable order

Disable order: job -> poller -> gateway -> controller.

1. Disable `plane-game/main-cd` and write the exact line `plane-game/main-cd=disabled` to the approved `job-disabled.ack` file.
2. Run `disable-stage-b.sh` as UID 1003. Before stopping the gateway or controller, it calls `manage-actions-poller.sh deactivate`. That idempotent path installs the reviewed disabled unit definitions, stops the poller timer and service, disables their persistent timer link, removes the `CD_TRIGGER_MODE=poller` drop-in, reloads the user manager, and refuses success unless the timer is exactly disabled/inactive, the service is static/inactive, and the effective selector is exactly `disabled`. This also closes a partially completed activation.
3. The same script stops only the `plane-preflight` user service `plane-game-webhook-gateway.service`.
4. The same script stops only `plane-game-jenkins-stage-b`. It never enables or starts a service and never uses a root-level systemd unit.

`deactivate` records the current kernel boot ID only after the disabled state is proven. After reboot, run `manage-actions-poller.sh verify-disabled-restart`; it requires a changed boot ID and re-proves the timer/service inactive state, persistent timer disablement, absence of the poller drop-in, and the effective `CD_TRIGGER_MODE=disabled` selector. Rollback remains incomplete until this post-reboot proof succeeds.

## Cold backup and restore

After disablement, `backup-home.sh` mounts one explicitly named Stage B home volume read-only, writes `jenkins-home.tgz`, and writes `jenkins-home.tgz.sha256`. Restore verifies that checksum before creating one new, versioned `plane-game-jenkins-stage-b-home-restore-YYYYMMDDTHHMMSSZ` volume. A failed restore removes only that newly created target. No existing home is overwritten or deleted.

## Rollback modes

- `first-release` requires both the disabled-job acknowledgement and the exact `plane-game=absent` no-app acknowledgement. It leaves Jenkins and the gateway stopped and preserves the durable home for investigation.
- `last-healthy` requires a bounded Stage B volume name in `last-healthy-home-volume`. It selects that volume in `active-home-volume` but leaves everything disabled; a later approved change may run the controller against it.

There is no prune, wildcard deletion, rootful Docker socket, Docker group grant, sudo, Nginx/TLS/DNS/SSH/firewall mutation, or public-route step in this package.
