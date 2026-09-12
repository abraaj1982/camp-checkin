import { Redirect } from "expo-router";
import { useApp } from "@/state/AppContext";

export default function Index() {
  const { isLoggedIn } = useApp();
  return <Redirect href={isLoggedIn ? "/home" : "/login"} />;
}
