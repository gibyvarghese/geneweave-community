// Expo babel config — preset installed with the rest of the RN tree in M3.
module.exports = function babel(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
