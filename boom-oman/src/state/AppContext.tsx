import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { generateOffers } from "@/data/mockDrivers";
import { Driver, Order, OrderStatus } from "@/types";

type AppState = {
  phone: string | null;
  isLoggedIn: boolean;
  login: (phone: string) => Promise<void>;
  logout: () => Promise<void>;

  offers: Driver[];
  requestDelivery: (pickup: string, dropoff: string, note: string) => void;

  activeOrder: Order | null;
  chooseDriver: (driver: Driver) => void;
  advanceOrderStatus: () => void;
  resetOrder: () => void;
};

const AppContext = createContext<AppState | null>(null);

const STORAGE_KEY = "boom_oman_phone";

const STATUS_FLOW: OrderStatus[] = [
  "driver_assigned",
  "picked_up",
  "on_the_way",
  "delivered",
];

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [offers, setOffers] = useState<Driver[]>([]);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      setPhone(value);
      setReady(true);
    });
  }, []);

  const login = useCallback(async (newPhone: string) => {
    await AsyncStorage.setItem(STORAGE_KEY, newPhone);
    setPhone(newPhone);
  }, []);

  const logout = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setPhone(null);
    setActiveOrder(null);
    setOffers([]);
  }, []);

  const requestDelivery = useCallback(
    (pickup: string, dropoff: string, note: string) => {
      const seed = Math.floor(Math.random() * 1000);
      const newOffers = generateOffers(seed);
      setOffers(newOffers);
      setActiveOrder({
        id: `ord-${Date.now()}`,
        pickup,
        dropoff,
        packageNote: note,
        createdAt: Date.now(),
        driver: null,
        status: "choosing_driver",
      });
    },
    []
  );

  const chooseDriver = useCallback((driver: Driver) => {
    setActiveOrder((prev) =>
      prev ? { ...prev, driver, status: "driver_assigned" } : prev
    );
  }, []);

  const advanceOrderStatus = useCallback(() => {
    setActiveOrder((prev) => {
      if (!prev || !prev.status || prev.status === "choosing_driver") return prev;
      const idx = STATUS_FLOW.indexOf(prev.status);
      const next = STATUS_FLOW[Math.min(idx + 1, STATUS_FLOW.length - 1)];
      return { ...prev, status: next };
    });
  }, []);

  const resetOrder = useCallback(() => {
    setActiveOrder(null);
    setOffers([]);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      phone,
      isLoggedIn: !!phone,
      login,
      logout,
      offers,
      requestDelivery,
      activeOrder,
      chooseDriver,
      advanceOrderStatus,
      resetOrder,
    }),
    [
      phone,
      login,
      logout,
      offers,
      requestDelivery,
      activeOrder,
      chooseDriver,
      advanceOrderStatus,
      resetOrder,
    ]
  );

  if (!ready) return null;

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
