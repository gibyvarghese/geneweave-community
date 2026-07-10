// SPDX-License-Identifier: MIT
/**
 * Admin tab schema — Tenancy Realm workbench.
 *
 * A single bespoke screen (`customView: 'realm-workbench'`) rather than CRUD: it drives the drift/merge,
 * state-overlay and share endpoints that already exist. `apiPath` points at the proposals list purely so
 * the shared list-loader has a harmless GET to hydrate before the custom view takes over the panel.
 */
import type { AdminTabMap } from '@weaveintel/core';

export const REALM_ADMIN_TABS: AdminTabMap = {
  'realm-workbench': {
    singular: 'Tenancy Realm',
    plural: 'Tenancy Realm',
    apiPath: 'admin/realm/proposals',
    listKey: 'proposals',
    cols: [],
    fields: [],
    readOnly: true,
    customView: 'realm-workbench',
  },
};
