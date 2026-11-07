# RecoVibe React Auth and Event Workflow

A standalone React + Vite example using Firebase Authentication and the modular Firebase Web SDK. Event submission and approval write directly from the browser to Firestore.

## Setup

1. In Firebase Console, select your project and enable **Authentication → Sign-in method → Email/Password**.
2. Create/enable the project's Cloud Firestore database.
3. Register or select a Firebase **Web app** under Project settings.
4. The shared `firebase.js` initializer at the repository root is configured for the `recovibe-v1` Web app. Do not copy credentials from the legacy project.
5. From this folder, install and run:

   ```sh
   npm install
   npm run dev
   ```

6. To verify a production bundle:

   ```sh
   npm run build
   ```

## Firestore data and roles

- `users/{uid}` stores the account profile and role. Student registration and the React workflow use this same UID-keyed collection.
- Signup creates only `user` or `organizer` roles.
- The `/setup-superadmin` page creates the first superadmin once, after email verification. Before using it, replace every `REPLACE_WITH_FIRST_SUPERADMIN_EMAIL` occurrence in `firestore.rules` with the exact email authorized to claim initial setup, then merge and publish the rules. The first successful transaction creates `users/{uid}` and the `system/bootstrap` lock together.
- The superadmin can use `/user-management` to create Admin, EO (stored as `organizer`), and Teacher accounts. The new Auth account is created on a secondary Firebase app so the superadmin remains signed in; if writing the matching `users/{uid}` profile fails, the new Auth account is removed.
- Never expose a service-account key in this React app. Client-side route protection is only a UX aid; Firestore rules enforce the roles.
- `events/{eventId}` starts with `status: "Pending Adviser Approval"` and includes `adviserUid` copied from the submitter's `users/{uid}.adviserUid` profile field. A superadmin assigns the submitter's Adviser in **User management** before the user can submit events.
- Managed reviewer accounts use the `adviser`, `hap`, or `osas` role. Approval proceeds Adviser → HAP → OSAS; reviewer queues and Firestore reads are restricted to the signed-in reviewer's current stage, each update is restricted to that stage, and only the assigned Adviser can access the first-stage queue.
- The public feed listens to events with `status: "approved"`; it updates after the OSAS approval without a page reload.

## Firestore security rules

`firestore.rules` contains an example ruleset for this workflow. **Review and merge its `users`, `system/bootstrap`, and `events` matches and helper functions into your project's current Firestore rules** in Firebase Console → Firestore Database → Rules. Replace the first-superadmin email placeholder in both rule checks before publishing. A Firebase project has one ruleset per Firestore database; replacing an existing ruleset may break other RecoVibe features. Publish the merged rules before testing signup, bootstrap, staff provisioning, or event submission.

The rules restrict first-admin bootstrap to the allowlisted, email-verified account and permanently lock it after the first successful setup. They also prevent users from assigning themselves a staff role, allow only a superadmin to provision managed roles, enforce ownership on submissions, require a valid assigned Adviser, and enforce the Adviser → HAP → OSAS approval sequence. Client-side route protection is only a UX aid; the rules enforce access.

## Existing repository integration

This app is isolated under `react-workflow/` because the repository's existing site is a separate static app. It imports the shared Firebase initializer from `firebase.js`, which is pinned to the `recovibe-v1` Web app configuration.

The workflow uses a Firestore `events` collection with fields tailored to this example. If integrating with the existing RecoVibe event data, review existing event formats and security rules before using the same collection.
