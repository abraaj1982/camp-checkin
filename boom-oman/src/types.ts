export type Driver = {
  id: string;
  name: string;
  rating: number;
  trips: number;
  vehicle: string;
  etaMinutes: number;
  price: number;
  avatarColor: string;
};

export type OrderStatus =
  | "choosing_driver"
  | "driver_assigned"
  | "picked_up"
  | "on_the_way"
  | "delivered";

export type Order = {
  id: string;
  pickup: string;
  dropoff: string;
  packageNote: string;
  createdAt: number;
  driver: Driver | null;
  status: OrderStatus;
};
