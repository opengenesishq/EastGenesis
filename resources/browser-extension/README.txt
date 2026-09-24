EastGenesis Browser Bridge — local unpacked extension 0.1.0

Install in Chrome or Edge:
1. Open the browser's extension manager and enable Developer mode.
2. Choose Load unpacked and select this directory.
3. In EastGenesis, open a task and choose Browser > Chrome / Edge > Browser extension.
4. Generate a pairing code. Open this extension on the HTTP(S) tab you want to authorize.
5. Paste the code, confirm the task name, then explicitly allow that task to use the tab.
6. Back in EastGenesis, select the authorized tab. Pairing by itself grants no task access.

Permissions:
- This extension requires debugger permission, which can read and modify attached pages.
- activeTab does not constrain debugger. No tab is attached until you explicitly authorize it.
- Your authorization covers this one tab and subsequent HTTP(S) pages in it.
- Only fixed read, screenshot, navigation, click, type and wait operations are accepted.
- Arbitrary scripts, arbitrary CDP forwarding, cookies, profile access and automatic search are not provided.

Revoke from the extension popup or EastGenesis to detach the tab. If disconnected, check any in-flight
operation's result on the original page, then pair again. Writes are never automatically retried.

The package is not a Chrome Web Store or Edge Add-ons publication. It uses a stable public manifest
key so EastGenesis can fill the local package ID automatically. No signing private key is included.
