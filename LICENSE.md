# Evieverse: Additional Terms under Section 7 of the GNU AGPLv3

Evieverse Copyright (C) 2026 Techfalos, LLC

Evieverse is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License, version 3, as published by the Free Software Foundation (the file LICENSE), supplemented by the additional terms below. The copyright holder adds these terms under Section 7 of that License, as permitted by Section 7(b) and Section 7(c). They are additional requirements, not additional permissions, and they apply to every copy of the Program and every modified version of it.

Evieverse is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for details.

Terms used here have the meanings the License gives them ("the Program", "modify", "convey", "Corresponding Source", and so on).

## 1. Definitions

"Modified version" means a version of the Program whose source code differs in any way from a release published by the copyright holder, including added, removed or changed files (for example, a trust plugin of your own added under src/plugins/trust), except for the changes listed below.

"Official trust plugin" means a trust plugin that is part of the Program's source code as published by the copyright holder in an official release of Evieverse.

None of the following, alone or together, makes a version of the Program a modified version:

a. setting the Program's documented configuration (environment variables or evieverse.config.json), choosing its supported backends, and deploying it with its supplied build and deployment files;

b. adding, removing or changing language files: files whose only content is the translation or localization of text the Program shows or returns to people (such as messages, labels and their translations), and which change nothing about how the Program behaves otherwise;

c. adding an official trust plugin, unchanged, under src/plugins/trust, including one from an official release other than the one the rest of your copy is based on. Official trust plugins never need to be disclosed under Term 2. A trust plugin that is not an official trust plugin, or an official one that you have changed, does make the version a modified version.

d. adding, removing or changing files under deploy/terraform (the Terraform deployment modules): files that describe the infrastructure the Program is deployed on and how it is configured there. Changes to these files never need to be disclosed under Term 2. This does not cover a change there that alters, when the Program is built or deployed, the source code of the rest of the Program; such a change does make the version a modified version.

"The disclosure" means the statement described in Term 2.

"The rules endpoint" means the GET /rules endpoint of the Program's HTTP API, which publicly reports how the server is configured and run.

## 2. Modified versions must be marked as different (Section 7(c))

If you run a modified version on a server that users interact with remotely through a computer network, or if you convey a modified version, the modified version must be marked as different from the original version, as follows:

a. The response of the rules endpoint must state that the server runs a modified version of Evieverse. If you have removed, renamed or replaced the rules endpoint, the statement must be given instead by an equivalent endpoint or web page that any user interacting with the server can reach without signing in, and that is linked from or documented in the same place as the server's API.

b. The statement must include:

- the release of Evieverse the modified version is based on; and
- where the Corresponding Source of the modified version can be obtained, as Section 13 of the License requires you to offer it.

c. The statement must be true, and must stay available for as long as the modified version is running for users. A modified version must not be configured, coded or presented so as to state or suggest that it is an unmodified release.

d. The supported way to comply. The Program provides the environment variables EVIEVERSE_MODIFIED and EVIEVERSE_SOURCE_URL. Setting EVIEVERSE_MODIFIED=true and EVIEVERSE_SOURCE_URL to the location of your Corresponding Source, without changing the code that reports them in the rules endpoint, satisfies Terms 2(a) and 2(b). You may instead meet those Terms in any other way that gives users the same information, just as publicly.

## 3. No misrepresentation of origin (Section 7(c))

You may not misrepresent a modified version as the original version of Evieverse, or as a release published by the copyright holder.

## 4. Preservation of notices (Section 7(b))

You must keep this file, with its terms unchanged, together with the file LICENSE in every copy of the Program and every modified version that you convey or make available under Section 13, and keep intact the notices in the source files that refer to these additional terms.

## 5. Nothing else is restricted

These terms add no restriction on commercial use, on who may use the Program, or on the purposes it is used for. The copyright holder intends every term here to be read as a reasonable marking or notice requirement within Sections 7(b) and 7(c) of the License.
