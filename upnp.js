// Minimal UPnP IGD client (no external deps): discovers the gateway via SSDP
// and adds/removes a port mapping via SOAP. Enough to auto-open a Minecraft
// server port on a typical home router.
import dgram from "dgram";
import http from "http";
import os from "os";
import { URL } from "url";

function log(...a) { try { console.log("[UPnP]", ...a); } catch { /* ignore */ } }

// Every usable (non-internal) IPv4 the machine has. On multi-homed machines
// (VPN/virtual adapters, multiple NICs) the router is only reachable from the
// interface actually on its subnet, so we must probe from ALL of them — probing
// just the "first" address is the #1 reason discovery silently fails.
function localIPv4List() {
  const ifaces = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) list.push(i.address);
    }
  }
  return list.length ? list : ["0.0.0.0"];
}

// Best-guess primary LAN IPv4 (prefers common private ranges) for the internal
// client of a port mapping.
function localIPv4() {
  const list = localIPv4List();
  return list.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) || list[0];
}

const SSDP_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
  "upnp:rootdevice",
  "ssdp:all",
];

// SSDP: find an InternetGatewayDevice and return its description-XML URL.
// One socket is bound per local interface so the multicast search leaves every
// adapter — whichever one is on the router's LAN gets an answer.
function discoverGateway(timeout = 6000) {
  return new Promise((resolve, reject) => {
    const addrs = localIPv4List();
    log("probing gateway on interfaces:", addrs.join(", ") || "(none)");
    const socks = [];
    let done = false;

    const finish = (err, loc) => {
      if (done) return;
      done = true;
      for (const s of socks) { try { s.close(); } catch { /* ignore */ } }
      if (err) { log("discovery failed:", err.message); reject(err); }
      else { log("gateway found at", loc); resolve(loc); }
    };

    const mkSearch = (sock) => () => {
      for (const st of SSDP_TARGETS) {
        const payload = Buffer.from(
          "M-SEARCH * HTTP/1.1\r\n" +
          "HOST: 239.255.255.250:1900\r\n" +
          'MAN: "ssdp:discover"\r\n' +
          "MX: 2\r\n" +
          "ST: " + st + "\r\n\r\n"
        );
        try { sock.send(payload, 0, payload.length, 1900, "239.255.255.250"); } catch { /* ignore */ }
      }
    };

    for (const local of addrs) {
      const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      socks.push(sock);
      sock.on("error", () => { try { sock.close(); } catch { /* ignore */ } });
      sock.on("message", (msg) => {
        const text = msg.toString();
        if (!/InternetGatewayDevice|WANIPConnection|WANPPPConnection|rootdevice/i.test(text)) return;
        const m = text.match(/LOCATION:\s*(\S+)/i);
        if (m) finish(null, m[1].trim());
      });
      try {
        sock.bind(0, local === "0.0.0.0" ? undefined : local, () => {
          try { sock.setMulticastTTL(4); } catch { /* ignore */ }
          if (local !== "0.0.0.0") { try { sock.setMulticastInterface(local); } catch { /* ignore */ } }
          try { sock.setBroadcast(true); } catch { /* ignore */ }
          const search = mkSearch(sock);
          search();
          // Re-send a couple of times — some routers drop the first probe.
          setTimeout(() => { if (!done) search(); }, 700);
          setTimeout(() => { if (!done) search(); }, 1600);
        });
      } catch (e) { log("bind failed on", local, e.message); }
    }

    setTimeout(() => finish(new Error("No UPnP gateway responded. Make sure UPnP/IGD is enabled in your router settings (also called 'NAT-PMP', 'Miniupnp' or 'UPnP IGD'), and that your firewall isn't blocking Redstone Launcher.")), timeout);
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

// From the device description, resolve the WAN connection service's control URL.
async function resolveService(descUrl) {
  const xml = await httpGet(descUrl);
  const base = new URL(descUrl);
  // Prefer WANIPConnection, then WANPPPConnection.
  for (const type of ["WANIPConnection", "WANPPPConnection"]) {
    const re = new RegExp(
      "<service>[\\s\\S]*?<serviceType>([^<]*" + type + "[^<]*)</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>[\\s\\S]*?</service>",
      "i"
    );
    const m = xml.match(re);
    if (m) {
      const controlURL = new URL(m[2], base).toString();
      return { serviceType: m[1].trim(), controlURL };
    }
  }
  throw new Error("Router has no WAN IP connection service");
}

function soap(controlURL, serviceType, action, bodyInner) {
  return new Promise((resolve, reject) => {
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      "<s:Body>" +
      `<u:${action} xmlns:u="${serviceType}">${bodyInner}</u:${action}>` +
      "</s:Body></s:Envelope>";
    const u = new URL(controlURL);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          "Content-Length": Buffer.byteLength(body),
          SOAPAction: `"${serviceType}#${action}"`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else {
            const err = (data.match(/<errorDescription>([^<]+)</i) || [])[1];
            reject(new Error(err || `UPnP action ${action} failed (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function openPort(port, protocol = "TCP", description = "Redstone Launcher") {
  log("openPort", port, protocol);
  const desc = await discoverGateway();
  const { serviceType, controlURL } = await resolveService(desc);
  log("using service", serviceType, "@", controlURL);
  const internal = localIPv4();
  await soap(controlURL, serviceType, "AddPortMapping",
    "<NewRemoteHost></NewRemoteHost>" +
    `<NewExternalPort>${port}</NewExternalPort>` +
    `<NewProtocol>${protocol}</NewProtocol>` +
    `<NewInternalPort>${port}</NewInternalPort>` +
    `<NewInternalClient>${internal}</NewInternalClient>` +
    "<NewEnabled>1</NewEnabled>" +
    `<NewPortMappingDescription>${description}</NewPortMappingDescription>` +
    "<NewLeaseDuration>0</NewLeaseDuration>"
  );
  let externalIP = null;
  try {
    const r = await soap(controlURL, serviceType, "GetExternalIPAddress", "");
    externalIP = (r.match(/<NewExternalIPAddress>([^<]*)</i) || [])[1] || null;
  } catch { /* ignore */ }
  return { success: true, internal, port, externalIP };
}

export async function closePort(port, protocol = "TCP") {
  const desc = await discoverGateway();
  const { serviceType, controlURL } = await resolveService(desc);
  await soap(controlURL, serviceType, "DeletePortMapping",
    "<NewRemoteHost></NewRemoteHost>" +
    `<NewExternalPort>${port}</NewExternalPort>` +
    `<NewProtocol>${protocol}</NewProtocol>`
  );
  return { success: true, port };
}

export async function getExternalIP() {
  const desc = await discoverGateway();
  const { serviceType, controlURL } = await resolveService(desc);
  const r = await soap(controlURL, serviceType, "GetExternalIPAddress", "");
  return (r.match(/<NewExternalIPAddress>([^<]*)</i) || [])[1] || null;
}

export default { openPort, closePort, getExternalIP };
