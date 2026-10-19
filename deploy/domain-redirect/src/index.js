// ensembleworkflow.com and www.ensembleworkflow.com -> the extension's
// Marketplace page. orchestrator.ensembleworkflow.com is NOT routed here; it
// stays on its Cloudflare tunnel to the control plane on the dev box.
const MARKETPLACE = "https://marketplace.visualstudio.com/items?itemName=j2kenton.vs-code-ai-helper";

export default {
  async fetch() {
    return Response.redirect(MARKETPLACE, 301);
  },
};
