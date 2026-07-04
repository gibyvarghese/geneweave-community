/**
 * (auth) group layout — a headerless stack for the pre-authenticated flow
 * (server picker → sign-in → biometric unlock). The root layout's
 * `useProtectedRoute` decides which of these is shown.
 */
import { Stack } from 'expo-router';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
