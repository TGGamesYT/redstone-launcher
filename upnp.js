// Minimal UPnP IGD client (no external deps): discovers the gateway via SSDP
// and adds/removes a port mapping via SOAP. Enough to auto-open a Minecraft
// server port on a typical home router.
import dgram from "dgram";
import http from "http";
import os from "os";
import { URL } from "url";

// Pick the machine's primary LAN IPv4.
function localIPv4() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

// SSDP: find an InternetGatewayDevice and return its description-XML URL.
// Bind to the LAN interface so the multicast search leaves the right adapter
// (common failure on machines with VPN/virtual adapters).
function discoverGateway(timeout = 5000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const local = localIPv4();
    const targets = [
      "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
      "urn:schemas-upnp-org:service:WANIPConnection:1",
      "urn:schemas-upnp-org:service:WANPPPConnection:1",
      "upnp:rootdevice",
      "ssdp:all",
    ];
    let done = false;
    const finish = (err, loc) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* ignore */ }
      err ? reject(err) : resolve(loc);
    };
    sock.on("error", (e) => finish(e));
    sock.on("message", (msg) => {
      const text = msg.toString();
      if (!/InternetGatewayDevice|WANIPConnection|WANPPPConnection|rootdevice/i.test(text)) return;
      const m = text.match(/LOCATION:\s*(\S+)/i);
      if (m) finish(null, m[1].trim());
    });
    const search = () => {
      for (const st of targets) {
        const payload = Buffer.from(
          "M-SEARCH * HTTP/1.1\r\n" +
          "HOST: 239.255.255.250:1900\r\n" +
          'MAN: "ssdp:discover"\r\n' +
          "MX: 2\r\n" +
          "ST: " + st + "\r\n\r\n"
        );
        sock.send(payload, 0, payload.length, 1900, "239.255.255.250");
      }
    };
    // Bind to the LAN IP so multicast goes out the correct interface.
    sock.bind(0, local, () => {
      try { sock.setMulticastTTL(4); } catch { /* ignore */ }
      try { sock.setMulticastInterface(local); } catch { /* ignore */ }
      try { sock.setBroadcast(true); } catch { /* ignore */ }
      search();
      // Re-send a couple of times — some routers drop the first probe.
      setTimeout(() => { if (!done) search(); }, 700);
      setTimeout(() => { if (!done) search(); }, 1600);
    });
    setTimeout(() => finish(new Error("No UPnP gateway responded (enable UPnP/IGD on your router; some routers call it 'NAT-PMP' or 'Miniupnp')")), timeout);
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
  const desc = await discoverGateway();
  const { serviceType, controlURL } = await resolveService(desc);
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
