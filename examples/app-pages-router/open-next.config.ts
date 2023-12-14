const config = {
  default: {},
  functions: {
    api: {
      routes: [
        "app/api/page",
        "app/api/client/route",
        "app/api/host/route",
        "pages/api/hello",
      ],
      patterns: ["/api/*"],
    },
  },
  buildCommand: "npx turbo build",
};

module.exports = config;
