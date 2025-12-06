const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, '..', 'public'))); 

// --- 상수 및 전역 상태 관리 변수 ---
let auctionItems = []; 
let initialAuctionItems = []; // ⭐ 원본 아이템 리스트 (1차 경매 대상)
let connectedPlayers = {}; 
const MAX_PLAYERS = 3;

let gameState = {
    phase: 'Lobby',                   // 'Lobby', 'Bidding_Main', 'Bidding_Failed', 'Finished', 'Transition'
    currentItemIndex: 0,              
    currentItem: null,
    topBid: 0,
    topBidderId: null,                
    timer: 0, 
    auctionInterval: null,
    transitionInterval: null, 
    posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0 }, 
};

// 경매 시간 및 규칙 상수
const MAX_TIME = 12;        
const FAILED_START_TIME = 15; 
const BID_INCREMENT = 10;
const MIN_START_BID = 10; 
const ANTI_SNIPING_WINDOW = 3; 
const ANTI_SNIPING_RESET = 7; 
const MAX_POS_PER_PLAYER = 1; // 포지션별 1명 제한으로 가정

// --- 헬퍼 함수 ---

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * 해당 포지션을 0개 보유한 플레이어 ID를 반환합니다.
 */
function getEligibleWinner(position) {
    for (const id in connectedPlayers) {
        // 포지션을 0개 보유한 플레이어를 찾음 (1명 제한 로직 하에서 자동 낙찰 대상)
        if (connectedPlayers[id].roster[position] === 0) {
            return id;
        }
    }
    return null;
}

function resetGame() {
    console.log('\n--- 🔁 60초 타이머 만료: 게임 상태 초기화 시작 ---');
    
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    if (gameState.transitionInterval) clearInterval(gameState.transitionInterval);

    gameState = {
        phase: 'Lobby',                   
        currentItemIndex: 0,              
        currentItem: null,
        topBid: 0,
        topBidderId: null,                
        timer: 0,
        auctionInterval: null,
        transitionInterval: null,
        posAcquired: { mid: 0, sup: 0, jungle: 0, ad: 0 }, 
    };

    // 2. 경매 아이템 목록 초기화 및 재셔플
    auctionItems = JSON.parse(JSON.stringify(initialAuctionItems));
    shuffleArray(auctionItems);

    // 3. 플레이어 정보 초기화
    for (const id in connectedPlayers) {
        connectedPlayers[id].ready = false;
        connectedPlayers[id].points = connectedPlayers[id].initialPoints || 1000; 
        connectedPlayers[id].roster = { mid: 0, sup: 0, jungle: 0, ad: 0, acquired: [] };
    }

    io.emit('game_update', { message: '✅ 경매가 자동으로 초기화되어 로비로 돌아갑니다. "준비 완료" 버튼을 다시 눌러주세요.' });
    io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ 
        nickname: p.nickname, 
        ready: p.ready,
        initialPoints: p.initialPoints 
    })) });
    sendPlayerStatusUpdate();
    sendAuctionStatusUpdate();
    console.log('--- ✅ 게임 상태 초기화 완료. 로비 모드로 전환됨 ---');
}

/**
 * ⭐ [수정 로직 반영] 자동 낙찰 로직.
 * 특정 포지션의 3명 중 2명이 낙찰되었고, 남은 1명의 선수가 아직 경매에 나오지 않았거나 유찰 상태일 때, 
 * 포지션을 0개 가진 유일한 플레이어에게 0원에 자동 낙찰합니다. (1명 제한 로직 하에서)
 */
function checkAndHandleAutoAcquisition(position) {
    // 1. 해당 포지션에 대해 3명 중 2명(MAX_PLAYERS-1)이 확보되었는지 확인 (자동 낙찰 발동 조건)
    if (gameState.posAcquired[position] === MAX_PLAYERS - 1) {
        
        // 2. 남은 선수 (미낙찰 상태인 선수)를 찾습니다. (auctionItems 전체를 탐색)
        const remainingItem = initialAuctionItems.find(item => 
            item.position === position && item.status !== 'ACQUIRED'
        );

        if (remainingItem) {
            const autoWinnerId = getEligibleWinner(position);
            
            // 3. 해당 포지션의 선수를 0개 보유한 유일한 플레이어가 남아있는 경우
            if (autoWinnerId) {
                
                // 해당 아이템의 상태를 ACQUIRED로 변경하고, 원본 리스트(auctionItems)에도 반영
                // (경매 리스트에서 상태 업데이트)
                const targetIndex = auctionItems.findIndex(item => item.id === remainingItem.id);
                if (targetIndex !== -1) {
                    auctionItems[targetIndex].status = 'ACQUIRED';
                    auctionItems[targetIndex].finalPrice = 0;
                    auctionItems[targetIndex].winnerId = autoWinnerId;
                }
                
                // (선수 리스트의 상태 업데이트)
                remainingItem.status = 'ACQUIRED'; 
                remainingItem.finalPrice = 0;
                remainingItem.winnerId = autoWinnerId;
                
                // 4. 플레이어 로스터 업데이트
                gameState.posAcquired[position]++; 
                connectedPlayers[autoWinnerId].roster[position]++;
                connectedPlayers[autoWinnerId].roster.acquired.push({
                    name: remainingItem.name, price: 0, position: remainingItem.position
                });
                
                // 5. 클라이언트에게 결과 전송
                io.emit('auto_acquisition', { 
                    item: remainingItem, winner: connectedPlayers[autoWinnerId].nickname 
                });
                sendPlayerStatusUpdate(); 
                sendAuctionStatusUpdate();
                console.log(`⭐ [자동 낙찰] ${remainingItem.name} 선수, ${connectedPlayers[autoWinnerId].nickname} 플레이어에게 0원으로 자동 낙찰됨.`);
            }
        }
    }
}


/**
 * 낙찰 또는 유찰 후 다음 경매로 넘어가기 전 5초 대기 상태를 시작합니다.
 */
function startTransition() {
    // 다음 아이템 정보를 미리 가져옵니다.
    let nextItem = null;
    let nextItemIndex = gameState.currentItemIndex + 1;

    // 1차 경매인 경우 (ACQUIRED 건너뛰기)
    if (gameState.phase === 'Bidding_Main') {
        while (nextItemIndex < auctionItems.length && auctionItems[nextItemIndex].status === 'ACQUIRED') {
            nextItemIndex++;
        }
        if (nextItemIndex < auctionItems.length) {
            nextItem = auctionItems[nextItemIndex];
        }
    } 
    // 유찰 경매인 경우 (FAILED 아이템만 순회)
    else if (gameState.phase === 'Bidding_Failed') {
        const failedItems = auctionItems.filter(i => i.status === 'FAILED');
        if (gameState.currentItemIndex + 1 < failedItems.length) {
             nextItem = failedItems[gameState.currentItemIndex + 1];
             // 유찰 경매 리스트의 인덱스이므로 nextItemIndex는 1 증가
             nextItemIndex = gameState.currentItemIndex + 1; 
        }
    }
    
    // 다음 경매가 남아있으면 Transition 시작
    if (nextItem) {
        gameState.phase = 'Transition';
        let countdown = 5;
        io.emit('transition_start', { countdown: countdown, nextItem: nextItem, currentItem: gameState.currentItem });

        if (gameState.transitionInterval) clearInterval(gameState.transitionInterval);
        gameState.transitionInterval = setInterval(() => {
            countdown--;
            io.emit('transition_update', { countdown: countdown });

            if (countdown <= 0) {
                clearInterval(gameState.transitionInterval);
                
                // 인덱스 업데이트 로직 분리:
                if (gameState.phase === 'Bidding_Main') {
                    // 1차 경매는 원본 리스트를 순회하므로, ACQUIRED를 건너뛴 최종 인덱스로 업데이트
                    gameState.currentItemIndex = auctionItems.findIndex(item => item.id === nextItem.id); 
                } else if (gameState.phase === 'Bidding_Failed') {
                    // 2차 경매는 유찰 리스트 인덱스로 업데이트
                    gameState.currentItemIndex = nextItemIndex;
                }
                
                startNextItemAuctionOrFailedAuction();
            }
        }, 1000);
    } else {
        checkEndOfAuction();
    }
}

/**
 * 현재 아이템의 경매를 종료하고 다음 단계로 진행합니다.
 */
function checkEndOfAuction() {
    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    const item = gameState.currentItem;

    // 낙찰/유찰 처리
    if (gameState.topBid > 0) {
        // 낙찰 처리
        item.status = 'ACQUIRED';
        item.finalPrice = gameState.topBid;
        item.winnerId = gameState.topBidderId;
        const winner = connectedPlayers[item.winnerId];
        const position = item.position;
        winner.points -= item.finalPrice; 
        winner.roster[position]++;
        winner.roster.acquired.push({ name: item.name, price: item.finalPrice, position: position });
        gameState.posAcquired[position]++; 
        io.emit('auction_result', { status: 'ACQUIRED', item: item, winner: winner.nickname });
        sendPlayerStatusUpdate(); 
        sendAuctionStatusUpdate();
        console.log(`[낙찰] ${item.name}이(가) ${item.finalPrice}에 낙찰. 낙찰자: ${winner.nickname}`);
        
        // ⭐ 낙찰 후 자동 낙찰 조건 체크 (이 부분이 중요)
        checkAndHandleAutoAcquisition(position);
    } else {
        // 유찰 처리
        item.status = 'FAILED'; 
        io.emit('auction_result', { status: 'FAILED', item: item });
        sendAuctionStatusUpdate(); 
        console.log(`[유찰] ${item.name} 경매 실패.`);
    }

    // 다음 경매 인덱스 이동 및 다음 단계 결정
    if (gameState.phase === 'Bidding_Main') {
        gameState.currentItemIndex++; // 현재 1차 경매 아이템 인덱스 증가
        if (gameState.currentItemIndex < auctionItems.length) {
             startTransition();
        } else {
             endMainAuction(); // 1차 경매 종료
        }
    } else if (gameState.phase === 'Bidding_Failed') {
        gameState.currentItemIndex++; // 유찰 경매 리스트 인덱스 증가
        const failedItems = auctionItems.filter(i => i.status === 'FAILED');
        if (gameState.currentItemIndex < failedItems.length) {
            startTransition();
        } else {
            handleFinalEnd(); // 2차 경매 종료
        }
    } else {
        // 이미 종료 상태이거나 기타 상태일 경우 최종 종료 처리
        handleFinalEnd();
    }
}


/**
 * Transition 종료 후 다음 경매(1차 또는 2차)를 시작하는 헬퍼 함수
 */
function startNextItemAuctionOrFailedAuction() {
    if (gameState.phase === 'Transition') {
        // Transition이 끝난 후 다음 단계를 결정
        const failedItems = auctionItems.filter(i => i.status === 'FAILED');
        if (failedItems.length > 0 && gameState.currentItemIndex < failedItems.length) {
            gameState.phase = 'Bidding_Failed';
        } else {
             gameState.phase = 'Bidding_Main';
        }
    }

    if (gameState.phase === 'Bidding_Main' && gameState.currentItemIndex < auctionItems.length) {
        startNextItemAuction();
    } else if (gameState.phase === 'Bidding_Failed') {
        startFailedAuction(); 
    } else {
        handleFinalEnd();
    }
}


/**
 * 다음 아이템의 경매를 시작합니다.
 */
function startNextItemAuction() {
    if (gameState.currentItemIndex >= auctionItems.length) {
        return endMainAuction();
    }
    
    gameState.currentItem = auctionItems[gameState.currentItemIndex];
    gameState.topBid = 0; 
    gameState.topBidderId = null;
    gameState.timer = MAX_TIME; 
    
    if (gameState.currentItem.status === 'ACQUIRED') {
        gameState.currentItemIndex++;
        return startNextItemAuction();
    }

    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    io.emit('auction_start', gameState.currentItem);
    sendAuctionStatusUpdate(); 
    console.log(`\n--- 1차 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}

/**
 * 최종 경매 종료 후 자동 초기화 타이머 설정
 */
function handleFinalEnd() {
    gameState.phase = 'Finished';
    console.log('--- 최종 경매 종료 ---');

    io.emit('game_update', { message: '모든 경매가 최종 종료되었습니다. 60초 후 자동으로 로비로 돌아가 초기화됩니다.' });
    
    let countdown = 60;
    const resetInterval = setInterval(() => {
        countdown--;
        io.emit('game_update', { message: `모든 경매가 최종 종료되었습니다. ${countdown}초 후 자동으로 로비로 돌아가 초기화됩니다.` });

        if (countdown <= 0) {
            clearInterval(resetInterval);
            resetGame(); 
        }
    }, 1000);
}


/**
 * 12개의 아이템 경매가 모두 끝났을 때 처리 (유찰 경매 준비)
 */
function endMainAuction() {
    const failedItems = auctionItems.filter(item => item.status === 'FAILED');

    if (failedItems.length > 0) {
        gameState.phase = 'Bidding_Failed';
        gameState.currentItemIndex = 0; 
        io.emit('game_update', { message: `1차 경매 종료. ${failedItems.length}개 유찰. 유찰 경매를 시작합니다!` });
        console.log('--- 1차 경매 종료. 유찰 경매 시작 ---');
        
        // 2차 경매를 위한 리스트는 'FAILED' 아이템만 남깁니다.
        auctionItems = auctionItems.filter(item => item.status !== 'ACQUIRED'); 
        
        startTransition(); // 유찰 경매 시작 전 5초 대기
    } else {
        // 유찰이 없을 경우, 최종 종료 처리
        gameState.currentItemIndex = auctionItems.length; 
        handleFinalEnd(); 
    }
}

/**
 * 유찰된 아이템의 경매를 시작합니다.
 */
function startFailedAuction() {
    const failedItems = auctionItems.filter(i => i.status === 'FAILED');

    if (gameState.currentItemIndex >= failedItems.length) {
        return handleFinalEnd();
    }

    gameState.currentItem = failedItems[gameState.currentItemIndex];
    gameState.topBid = 0; 
    gameState.topBidderId = null;
    gameState.timer = FAILED_START_TIME; 

    if (gameState.auctionInterval) clearInterval(gameState.auctionInterval);
    gameState.auctionInterval = setInterval(() => {
        gameState.timer--;
        io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });

        if (gameState.timer <= 0) {
            checkEndOfAuction();
        }
    }, 1000);

    io.emit('auction_start', gameState.currentItem);
    sendAuctionStatusUpdate(); 
    console.log(`\n--- 2차 경매 시작: ID ${gameState.currentItem.id} (${gameState.currentItem.name}) ---`);
}

function sendPlayerStatusUpdate() {
    const playerStatuses = Object.entries(connectedPlayers).map(([id, player]) => ({
        id: id,
        nickname: player.nickname,
        points: player.points,
        roster: player.roster.acquired,
        isTopBidder: id === gameState.topBidderId
    }));
    io.emit('player_status_update', playerStatuses);
}

function sendAuctionStatusUpdate() {
    // 1차 경매 아이템 리스트(initialAuctionItems)의 상태를 기준으로 UI 업데이트
    const auctionStatus = initialAuctionItems.map((item, index) => ({
        sequence: index + 1, 
        name: item.name,
        position: item.position,
        status: item.status,
    }));
    io.emit('auction_status_update', auctionStatus);
}


// --- 초기 CSV 로딩 ---
function loadCSV() {
    const filePath = path.join(__dirname, '..', 'data', 'items.csv');
    const itemsBeforeShuffle = [];
    fs.createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => {
            itemsBeforeShuffle.push({
                id: row.id,
                name: row.name,
                position: row.position,
                price: parseInt(row.start_price), 
                status: 'UNSOLD', 
                winnerId: null,
                finalPrice: 0,
            });
        })
        .on('end', () => {
            // 1. 초기 전체 목록 (순서 미정) 저장
            initialAuctionItems = itemsBeforeShuffle;
            
            // 2. 경매용 목록은 셔플 후 저장
            const auctionList = JSON.parse(JSON.stringify(itemsBeforeShuffle));
            shuffleArray(auctionList);
            auctionItems = auctionList;
            
            console.log(`✅ ${auctionItems.length}명의 선수 로딩 및 순서 랜덤 섞기 완료.`);
        });
}
loadCSV();


// --- Socket.io 이벤트 핸들러 ---
io.on('connection', (socket) => {
    
    if (Object.keys(connectedPlayers).length < MAX_PLAYERS) {
        connectedPlayers[socket.id] = {
            nickname: `P${Object.keys(connectedPlayers).length + 1}`,
            ready: false,
            points: 1000, 
            initialPoints: 1000, 
            roster: { mid: 0, sup: 0, jungle: 0, ad: 0, acquired: [] }
        };
        socket.emit('player_info', { id: socket.id, nickname: connectedPlayers[socket.id].nickname, initialPoints: connectedPlayers[socket.id].initialPoints });
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ 
            nickname: p.nickname, 
            ready: p.ready,
            initialPoints: p.initialPoints 
        })) });
        
        sendPlayerStatusUpdate();
        sendAuctionStatusUpdate();
        
    } else {
        socket.emit('full_server', '서버에 최대 인원 3명이 접속해 있습니다.');
        socket.disconnect();
        return;
    }

    // 닉네임 및 초기 포인트 설정 이벤트 핸들러
    socket.on('set_player_config', (data) => {
        if (connectedPlayers[socket.id]) {
            const { nickname, initialPoints } = data;
            
            if (!nickname || typeof initialPoints !== 'number' || initialPoints < 100 || initialPoints % 100 !== 0) {
                 return socket.emit('error_message', '유효하지 않은 닉네임 또는 시작 포인트입니다. (100 단위 이상)');
            }
            
            connectedPlayers[socket.id].nickname = nickname;
            connectedPlayers[socket.id].initialPoints = initialPoints; 
            connectedPlayers[socket.id].points = initialPoints; 

            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ 
                nickname: p.nickname, 
                ready: p.ready,
                initialPoints: p.initialPoints 
            })) });
            sendPlayerStatusUpdate(); 
        }
    });

    socket.on('ready', () => {
        if (connectedPlayers[socket.id] && !connectedPlayers[socket.id].ready && gameState.phase === 'Lobby') {
            
            const allPointsSet = Object.values(connectedPlayers).every(p => p.initialPoints && p.initialPoints >= 100);
            if (!allPointsSet) {
                 return socket.emit('error_message', '모든 플레이어가 유효한 시작 포인트를 설정해야 게임을 시작할 수 있습니다.');
            }
            
            connectedPlayers[socket.id].ready = true;
            
            const readyCount = Object.values(connectedPlayers).filter(p => p.ready).length;
            io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ 
                nickname: p.nickname, 
                ready: p.ready,
                initialPoints: p.initialPoints 
            })) });

            if (readyCount === MAX_PLAYERS) {
                gameState.phase = 'Bidding_Main';
                Object.values(connectedPlayers).forEach(p => p.points = p.initialPoints); 
                io.emit('game_start', '3명 모두 준비 완료! 경매를 시작합니다.');
                startNextItemAuction();
            }
        }
    });


    // [경매: 입찰] 이벤트
    socket.on('bid', (newPrice) => {
        if (gameState.phase !== 'Bidding_Main' && gameState.phase !== 'Bidding_Failed') return;
        if (!connectedPlayers[socket.id] || !gameState.currentItem) return;
        
        const itemPosition = gameState.currentItem.position;
        const player = connectedPlayers[socket.id];

        // 1. 포지션별 1명 이상 보유 시 입찰 금지 
        if (player.roster[itemPosition] >= MAX_POS_PER_PLAYER) { 
            return socket.emit('error_message', `${itemPosition.toUpperCase()} 포지션 선수는 이미 보유하고 있어 입찰할 수 없습니다. (${MAX_POS_PER_PLAYER}명 제한)`);
        }

        // 2. 연속 입찰 금지
        if (socket.id === gameState.topBidderId) {
            return socket.emit('error_message', '연속 입찰은 불가능합니다. 다음 플레이어만 입찰할 수 있습니다.');
        }

        // 3. 10 포인트 단위 체크
        if (newPrice % BID_INCREMENT !== 0) {
            return socket.emit('error_message', `입찰은 ${BID_INCREMENT} 포인트 단위로만 가능합니다.`);
        }

        const currentPrice = gameState.topBid;
        
        // 4. 최소 입찰 금액 계산
        let requiredPrice;
        if (currentPrice === 0) {
            requiredPrice = MIN_START_BID;
        } else {
            requiredPrice = currentPrice + BID_INCREMENT; 
        }

        if (newPrice < requiredPrice) {
            return socket.emit('error_message', `최소 입찰 금액은 ${requiredPrice} 포인트입니다.`);
        }
        
        // 5. 포인트 잔액 확인
        if (newPrice > player.points) {
            return socket.emit('error_message', `보유 포인트(${player.points}p)보다 높은 금액(${newPrice}p)으로는 입찰할 수 없습니다.`);
        }
        
        // 입찰 성공 처리
        gameState.topBid = newPrice;
        gameState.topBidderId = socket.id;
        
        // 안티 스나이핑
        if (gameState.timer <= ANTI_SNIPING_WINDOW) {
            gameState.timer = ANTI_SNIPING_RESET;
            io.emit('update_timer', { itemId: gameState.currentItem.id, time: gameState.timer });
            console.log(`[Sniping] 타이머가 ${ANTI_SNIPING_RESET}초로 리셋되었습니다.`);
        }

        io.emit('update_bid', { 
            itemId: gameState.currentItem.id, 
            price: newPrice, 
            bidder: connectedPlayers[socket.id].nickname 
        });
        
        sendPlayerStatusUpdate();
    });

    socket.on('disconnect', () => {
        delete connectedPlayers[socket.id];
        io.emit('lobby_update', { players: Object.values(connectedPlayers).map(p => ({ 
            nickname: p.nickname, 
            ready: p.ready,
            initialPoints: p.initialPoints
        })) });
        sendPlayerStatusUpdate();
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 TheUlim_Auction 서버 시작 (Port ${PORT})`);
});