const config = {
  default: {
    override: {
      wrapper: "aws-lambda-streaming",
    },
    experimentalBundledNextServer: true,
  },
  functions: {},
  buildCommand: "npx turbo build",
};

module.exports = config;
