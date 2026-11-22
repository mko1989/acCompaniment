//! `appConfigManager.getNetworkInterfaces()`: the machine's external IPv4 addresses, as
//! `os.networkInterfaces()` lists them (libuv's `uv_interface_addresses`: interfaces that are up
//! and running, grouped by name in order of first appearance), each with the server's URLs.

use indexmap::IndexMap;
use serde_json::{Value, json};

/// `{ name, address, httpUrl, wsUrl }` per external IPv4 address.
pub fn interfaces(port: &Value) -> Vec<Value> {
    let port = crate::core::jsv::to_js_string(port);
    ipv4_by_name()
        .into_iter()
        .flat_map(|(name, addrs)| {
            let port = port.clone();
            addrs.into_iter().map(move |address| {
                json!({
                    "name": name,
                    "address": address,
                    "httpUrl": format!("http://{address}:{port}"),
                    "wsUrl": format!("ws://{address}:{port}"),
                })
            })
        })
        .collect()
}

#[cfg(unix)]
fn ipv4_by_name() -> IndexMap<String, Vec<String>> {
    use nix::net::if_::InterfaceFlags;
    let mut by_name: IndexMap<String, Vec<String>> = IndexMap::new();
    let Ok(addrs) = nix::ifaddrs::getifaddrs() else {
        return by_name;
    };
    for ifa in addrs {
        // libuv skips interfaces that are not both up and running, and entries without an
        // address; it lists IPv4 and IPv6 (not link-layer) addresses.
        if !(ifa.flags.contains(InterfaceFlags::IFF_UP)
            && ifa.flags.contains(InterfaceFlags::IFF_RUNNING))
        {
            continue;
        }
        let Some(addr) = ifa.address else { continue };
        let v4 = addr.as_sockaddr_in().map(|a| a.ip());
        let is_v6 = addr.as_sockaddr_in6().is_some();
        if v4.is_none() && !is_v6 {
            continue;
        }
        let entry = by_name.entry(ifa.interface_name.clone()).or_default();
        // `family === 'IPv4' && !internal` (internal = loopback).
        if let Some(ip) = v4
            && !ifa.flags.contains(InterfaceFlags::IFF_LOOPBACK)
        {
            entry.push(ip.to_string());
        }
    }
    by_name
}

#[cfg(not(unix))]
fn ipv4_by_name() -> IndexMap<String, Vec<String>> {
    // Windows: to do before the lift (MAP.md, ADR-009).
    IndexMap::new()
}
