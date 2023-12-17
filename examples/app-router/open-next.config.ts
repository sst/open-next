const config = {
  functions: {
    default: {
      override: {
        wrapper: "aws-lambda-streaming",
      },
    },
  },
  buildCommand: "npx turbo build",
};

module.exports = config;
