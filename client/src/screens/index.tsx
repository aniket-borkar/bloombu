import type { ComponentType } from "react";
import { ChartScreen } from "../components/ChartScreen";
import type { Sector } from "../terminal/sectors";
import { BlpScreen, IbScreen, MsgScreen, UNAVAILABLE_FUNCTIONS, UnavailableScreen } from "./CollabScreens";
import { BqScreen, CnScreen, DesScreen, MgmtScreen, NScreen, TopScreen } from "./CompanyScreens";
import { AnrScreen, DvdScreen, EeScreen, ErnScreen, FaScreen, HdsScreen, RelsScreen, RvScreen } from "./FundamentalScreens";
import {
  BtmmScreen,
  EcoScreen,
  EcstScreen,
  EqsScreen,
  FxcScreen,
  GcScreen,
  GlcoScreen,
  ImapScreen,
  MostScreen,
  WbScreen,
  WcrsScreen,
  WeiScreen,
} from "./MarketScreens";
import { AlertScreen } from "./AlertScreen";
import { AskScreen } from "./AskScreen";
import { BacktestScreen } from "./BacktestScreen";
import { FldsScreen } from "./FldsScreen";
import { LayoutScreen } from "./LayoutScreen";
import { MembScreen } from "./MembScreen";
import { QrScreen } from "./QrScreen";
import { WirpScreen } from "./WirpScreen";
import { FrdScreen } from "./FrdScreen";
import { TradeScreen } from "./TradeScreen";
import { SrcScreen } from "./SrcScreen";
import { BriefScreen } from "./BriefScreen";
import { BqlScreen, SheetScreen } from "./SheetScreens";
import { PortScreen, PrtuScreen } from "./PortfolioScreens";
import { BetaScreen, CtScreen, HpScreen, OmonScreen, OvmlScreen, TraScreen, YasScreen } from "./PriceScreens";
import type { ScreenProps } from "./common";

export interface ScreenDef {
  component: ComponentType<ScreenProps>;
  /** Sectors the function supports; undefined means any. */
  sectors?: Sector[];
}

const EQUITY: Sector[] = ["Equity"];

const Chart = (props: ScreenProps) => <ChartScreen panel={props.panel} security={props.security!} fn={props.fn} />;

export const SCREEN_REGISTRY: Record<string, ScreenDef> = {
  DES: { component: DesScreen },
  GP: { component: Chart },
  GIP: { component: Chart },
  GPO: { component: Chart },
  HP: { component: HpScreen },
  BQ: { component: BqScreen },
  CN: { component: CnScreen },
  FA: { component: FaScreen, sectors: EQUITY },
  EE: { component: EeScreen, sectors: EQUITY },
  ERN: { component: ErnScreen, sectors: EQUITY },
  ANR: { component: AnrScreen, sectors: EQUITY },
  HDS: { component: HdsScreen, sectors: EQUITY },
  DVD: { component: DvdScreen, sectors: EQUITY },
  RV: { component: RvScreen, sectors: EQUITY },
  OMON: { component: OmonScreen, sectors: EQUITY },
  MGMT: { component: MgmtScreen, sectors: EQUITY },
  RELS: { component: RelsScreen, sectors: EQUITY },
  BETA: { component: BetaScreen, sectors: EQUITY },
  TRA: { component: TraScreen, sectors: ["Equity", "Index"] },
  OVML: { component: OvmlScreen, sectors: ["Equity", "Index", "Curncy", "Comdty"] },
  CT: { component: CtScreen, sectors: ["Comdty"] },
  YAS: { component: YasScreen, sectors: ["Govt", "Corp", "Mtge", "Muni", "Index"] },
  WEI: { component: WeiScreen },
  W: { component: WeiScreen },
  WB: { component: WbScreen },
  WCRS: { component: WcrsScreen },
  FXC: { component: FxcScreen },
  GC: { component: GcScreen },
  BTMM: { component: BtmmScreen },
  GLCO: { component: GlcoScreen },
  TOP: { component: TopScreen },
  N: { component: NScreen },
  MOST: { component: MostScreen },
  IMAP: { component: ImapScreen },
  ECO: { component: EcoScreen },
  ECST: { component: EcstScreen },
  EQS: { component: EqsScreen },
  MSG: { component: MsgScreen },
  IB: { component: IbScreen },
  BLP: { component: BlpScreen },
  ASK: { component: AskScreen },
  ALRT: { component: AlertScreen },
  LAYOUT: { component: LayoutScreen },
  QR: { component: QrScreen, sectors: ["Equity", "Curncy", "Comdty", "Index"] },
  MEMB: { component: MembScreen, sectors: ["Index"] },
  WIRP: { component: WirpScreen },
  FRD: { component: FrdScreen, sectors: ["Curncy"] },
  TRADE: { component: TradeScreen },
  SRC: { component: SrcScreen },
  BRIEF: { component: BriefScreen },
  BTST: { component: BacktestScreen, sectors: ["Equity", "Index", "Curncy", "Comdty", "Govt"] },
  FLDS: { component: FldsScreen },
  SHEET: { component: SheetScreen },
  BQL: { component: BqlScreen },
  PORT: { component: PortScreen },
  PRTU: { component: PrtuScreen },
  ...Object.fromEntries(UNAVAILABLE_FUNCTIONS.map((fn) => [fn, { component: UnavailableScreen }])),
};

export function isUnavailable(fn: string): boolean {
  return UNAVAILABLE_FUNCTIONS.includes(fn);
}
