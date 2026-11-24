// Read-only Sierra Chart study: publishes depth and recent trades to a local file.
// Reads simulation orders/fills only. Never submits, modifies or cancels orders.
#define NOMINMAX
#include "sierrachart.h"
#include <fstream>
#include <sstream>
#include <iomanip>
#include <chrono>

SCDLLName("HFTENGINE Live Market Data")

static std::string Quote(const char* text) {
    std::string result = "\"";
    for (const unsigned char c : std::string(text)) {
        if (c == '\\' || c == '"') result += '\\';
        if (c >= 32) result += static_cast<char>(c);
    }
    return result + "\"";
}

static double UtcMs(SCStudyInterfaceRef sc, const SCDateTime& value) {
    if (value.GetAsDouble() <= 0) return 0;
    return (sc.ConvertDateTimeFromChartTimeZone(value, TIMEZONE_UTC).GetAsDouble() - 25569.0) * 86400000.0;
}

static void AccountSnapshot(SCStudyInterfaceRef sc, std::ostringstream& json) {
    const bool simulated = sc.GlobalTradeSimulationIsOn != 0;
    json << ",\"sierraAccount\":{\"version\":1,\"account\":" << Quote(sc.SelectedTradeAccount.GetChars())
         << ",\"symbol\":" << Quote(sc.Symbol.GetChars()) << ",\"chartNumber\":" << sc.ChartNumber
         << ",\"simulation\":" << (simulated ? "true" : "false") << ",\"position\":";
    s_SCPositionData position;
    if (simulated && sc.GetTradePosition(position) > 0) {
        json << "{\"quantity\":" << position.PositionQuantity << ",\"averagePrice\":" << position.AveragePrice
             << ",\"openPnl\":" << position.OpenProfitLoss << ",\"dailyPnl\":" << position.DailyProfitLoss << '}';
    } else json << "null";
    json << ",\"orders\":[";
    int orderCount = 0;
    bool truncated = false;
    if (simulated) for (int index = 0; ; ++index) {
        s_SCTradeOrder order;
        if (sc.GetOrderByIndex(index, order) == SCTRADING_ORDER_ERROR) break;
        if (!order.IsSimulated || order.TradeAccount != sc.SelectedTradeAccount || order.Symbol != sc.Symbol) continue;
        if (order.BuySell != BSE_BUY && order.BuySell != BSE_SELL) continue;
        if (orderCount == 200) { truncated = true; break; }
        if (orderCount++) json << ',';
        std::string type = order.OrderType.GetChars();
        std::string upper = type;
        std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
        const char* role = upper.find("STOP") != std::string::npos ? "STOP"
            : order.ParentInternalOrderID && order.IsLimitOrder() ? "TP" : "ENTRY";
        json << "{\"id\":" << order.InternalOrderID << ",\"side\":\"" << (order.BuySell == BSE_BUY ? "buy" : "sell")
             << "\",\"type\":" << Quote(type.c_str()) << ",\"status\":" << Quote(OrderStatusToString(order.OrderStatusCode))
             << ",\"working\":" << (order.IsWorking() ? "true" : "false") << ",\"quantity\":" << order.OrderQuantity
             << ",\"filled\":" << order.FilledQuantity << ",\"price\":" << order.Price1 << ",\"price2\":" << order.Price2
             << ",\"parentId\":" << order.ParentInternalOrderID << ",\"role\":\"" << role
             << "\",\"entryMs\":" << UtcMs(sc, order.EntryDateTime)
             << ",\"queueEstimate\":" << (order.EstimatedPositionInQueue > 0 ? std::to_string(order.EstimatedPositionInQueue) : "null")
             << ",\"updatedMs\":" << UtcMs(sc, order.LastActivityTime) << '}';
    }
    json << "],\"ordersTruncated\":" << (truncated ? "true" : "false") << ",\"fills\":[";
    const int total = simulated ? sc.GetOrderFillArraySize() : 0;
    bool comma = false;
    for (int index = std::max(0, total - 300); index < total; ++index) {
        s_SCOrderFillData fill;
        if (!sc.GetOrderFillEntry(index, fill) || !fill.IsSimulated || fill.TradeAccount != sc.SelectedTradeAccount || fill.Symbol != sc.Symbol) continue;
        if (fill.BuySell != BSE_BUY && fill.BuySell != BSE_SELL) continue;
        if (comma) json << ',';
        comma = true;
        std::ostringstream key;
        key << fill.InternalOrderID << ':' << std::fixed << std::setprecision(0) << UtcMs(sc, fill.FillDateTime) << ':' << index;
        json << "{\"key\":" << Quote(key.str().c_str()) << ",\"orderId\":" << fill.InternalOrderID
             << ",\"side\":\"" << (fill.BuySell == BSE_BUY ? "buy" : "sell") << "\",\"quantity\":" << fill.Quantity
             << ",\"price\":" << fill.FillPrice << ",\"timeMs\":" << UtcMs(sc, fill.FillDateTime) << '}';
    }
    json << "],\"totalFills\":" << total << '}';
}

SCSFExport scsf_HFTEngineLive(SCStudyInterfaceRef sc) {
    if (sc.SetDefaults) {
        sc.GraphName = "HFTENGINE Live Depth and Trades";
        sc.StudyDescription = "Read-only local connection for the HFTENGINE MNQ dashboard.";
        sc.AutoLoop = 0;
        sc.GraphRegion = 0;
        sc.UpdateAlways = 1;
        sc.UsesMarketDepthData = 1;
        sc.MaintainTradeStatisticsAndTradesData = 1;
        sc.SendOrdersToTradeService = false;
        sc.Input[0].Name = "Output JSON file";
        sc.Input[0].SetString("C:\\Users\\Darwin\\Market Code\\HFTENGINE\\data\\sierra\\latest.json");
        sc.Input[1].Name = "Depth levels per side";
        sc.Input[1].SetInt(40);
        sc.Input[1].SetIntLimits(1, 200);
        return;
    }
    if (sc.LastCallToFunction) return;
    sc.MaintainTradeStatisticsAndTradesData = 1;
    sc.SendOrdersToTradeService = false;

    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    auto& previousWrite = sc.GetPersistentInt64(1);
    if (now == previousWrite) return;
    const auto bridgeInterval = previousWrite ? now - previousWrite : 0;
    previousWrite = now;

    std::ostringstream json;
    json << std::fixed << std::setprecision(6);
    json << "{\"version\":1,\"symbol\":" << Quote(sc.Symbol.GetChars())
         << ",\"publishedMs\":" << now
         << ",\"chartUpdateMs\":" << sc.ChartUpdateIntervalInMilliseconds
         << ",\"bridgeIntervalMs\":" << bridgeInterval
         << ",\"connected\":" << (sc.ServerConnectionState == SCS_CONNECTED ? "true" : "false")
         << ",\"replay\":" << (sc.ReplayStatus != REPLAY_STOPPED ? "true" : "false")
         << ",\"delaySeconds\":" << sc.GetDataDelayFromChart(sc.ChartNumber).GetAsDouble() * 86400.0
         << ",\"tickSize\":" << sc.TickSize
         << ",\"last\":" << sc.LastTradePrice;

    for (int side = 0; side < 2; ++side) {
        json << (side == 0 ? ",\"bids\":[" : ",\"asks\":[");
        const int available = side == 0 ? sc.GetBidMarketDepthNumberOfLevels() : sc.GetAskMarketDepthNumberOfLevels();
        bool comma = false;
        for (int level = 0; level < std::min(available, sc.Input[1].GetInt()); ++level) {
            s_MarketDepthEntry entry;
            const int ok = side == 0 ? sc.GetBidMarketDepthEntryAtLevel(entry, level) : sc.GetAskMarketDepthEntryAtLevel(entry, level);
            if (!ok || entry.Price <= 0) continue;
            if (comma) json << ',';
            comma = true;
            json << "[" << entry.AdjustedPrice << ',' << entry.Quantity << ',' << entry.NumOrders << ']';
        }
        json << ']';
    }

    c_SCTimeAndSalesArray tape;
    sc.GetTimeAndSales(tape);
    json << ",\"trades\":[";
    int count = 0;
    for (int i = tape.Size() - 1; i >= 0 && count < 1000; --i) {
        const auto& trade = tape[i];
        if (trade.Type != SC_TS_BID && trade.Type != SC_TS_ASK) continue;
        if (count++) json << ',';
        const double multiplier = sc.RealTimePriceMultiplier == 0 ? 1 : sc.RealTimePriceMultiplier;
        json << "{\"sequence\":" << trade.Sequence
             << ",\"timeMs\":" << (trade.DateTime.GetAsDouble() - 25569.0) * 86400000.0
             << ",\"price\":" << trade.Price * multiplier
             << ",\"quantity\":" << trade.Volume
             << ",\"side\":\"" << (trade.Type == SC_TS_ASK ? "buy" : "sell") << "\"}";
    }
    json << ']';
    AccountSnapshot(sc, json);
    json << '}';

    char projectOutput[32768] = {};
    const DWORD outputLength = GetEnvironmentVariableA("HFTENGINE_LIVE_FILE", projectOutput, sizeof(projectOutput));
    const std::string destination = outputLength > 0 && outputLength < sizeof(projectOutput)
        ? projectOutput : sc.Input[0].GetString();
    const std::string temporary = destination + ".tmp";
    bool success = false;
    {
        std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
        file << json.str();
        file.close();
        success = !file.fail();
    }
    if (success) success = MoveFileExA(temporary.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING) != 0;
    auto& reportedError = sc.GetPersistentInt(2);
    if (!success && !reportedError) {
        sc.AddMessageToLog("HFTENGINE: cannot write output file. Check the study's Output JSON file and its folder.", 1);
        reportedError = 1;
    }
    if (success) reportedError = 0;
}
