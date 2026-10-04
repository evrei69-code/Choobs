const servers = [
  {
    id: "nl-amsterdam",
    name: "Netherlands",
    location: "Amsterdam",
    flag: "🇳🇱",
    address: "",
    port: 443,
    protocol: "HTTPS",
    ping: 42,
    description: ""
  },
  {
    id: "de-frankfurt",
    name: "Germany",
    location: "Frankfurt",
    flag: "🇩🇪",
    address: "",
    port: 443,
    protocol: "HTTPS",
    ping: 51,
    description: ""
  },
  {
    id: "fi-helsinki",
    name: "Finland",
    location: "Helsinki",
    flag: "🇫🇮",
    address: "",
    port: 443,
    protocol: "HTTPS",
    ping: 38,
    description: ""
  }
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = servers;
}
