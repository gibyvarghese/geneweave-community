// SPDX-License-Identifier: MIT
/**
 * Admin tab schema — the Upgrade Center.
 *
 * A single bespoke screen (`customView: 'upgrade-center'`) rather than CRUD: it drives the upgrade lifecycle
 * (check/preview/apply/verify) and the review queue endpoints that already exist. `apiPath` points at the
 * read-only upgrade status purely so the shared list-loader has a harmless GET to hydrate before the custom
 * view takes over the panel.
 */
import type { AdminTabMap } from '@weaveintel/core';

export const UPGRADE_ADMIN_TABS: AdminTabMap = {
  'upgrade-center': {
    singular: 'Upgrade Center',
    plural: 'Upgrade Center',
    apiPath: 'admin/upgrade/status',
    listKey: 'latest',
    cols: [],
    fields: [],
    readOnly: true,
    customView: 'upgrade-center',
  },
};
