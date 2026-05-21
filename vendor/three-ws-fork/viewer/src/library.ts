import { Exhibit } from './components/Exhibit';
import { FloatingModel } from './components/Models/FloatingModel';
import { AnimationModel } from './components/Models/AnimationModel';
import { HalfBodyModel } from './components/Models/HalfBodyModel';
import { StaticModel } from './components/Models/StaticModel';
import { PoseModel } from './components/Models/PoseModel';
import { EnvironmentModel } from './components/Models/EnvironmentModel';
import { Avatar, CAMERA, AvatarProps } from './components/Avatar';
import { FloorReflection } from './components/FloorReflection';
import { useDeviceDetector } from './hooks/useDeviceDetector/use-device-detector.hook';

export {
  Exhibit,
  FloatingModel,
  EnvironmentModel,
  AnimationModel,
  HalfBodyModel,
  StaticModel,
  PoseModel,
  Avatar,
  CAMERA,
  FloorReflection,
  useDeviceDetector
};

export type { AvatarProps };
