# Legacy Plugin Delivery

`delivery/plugin-delivery` is retained only as a legacy compatibility fixture
for client-decrypt round-trip tests.

Do not use this package for new protected module publication or grant issuance.
The canonical protected delivery flow is `licensing/core`, which publishes one
encrypted content version, stores the content key with the module publication,
wraps that key per requester, and emits provider-signed `$LGR` grants.

This legacy package performs one-off bundle encryption inside `deliver_plugin`
and emits grants without `provider_signature`, so it is intentionally excluded
from the default module test matrix and should not be deployed as a production
module-delivery provider.
