import React, { useEffect, useState } from 'react';
import styles from './Load.module.css';
import { ethers } from 'ethers';
import { useWeb3React } from '@web3-react/core';
import { metaMask } from '../connectors/metamask';
import { ViewContext, ViewMode } from '../context/ViewContext';

import { SoundContext } from "../context/SoundContext"
import { AudioContext } from "../context/AudioContext"

function Load() {
    const { accounts, provider } = useWeb3React();
    const account = accounts?.[0];
    const [characters, setCharacters] = useState([]);
    const { setViewMode } = React.useContext(ViewContext);
    const { playSound } = React.useContext(SoundContext)
    const { isMute } = React.useContext(AudioContext)

    useEffect(() => {
        if (account && provider) {
            const contractAddress = '0x69341F01C2113E2d09Cd4837bbF1786dfbBc41d7';
            const abi = [
                'function balanceOf(address owner) external view returns (uint256)',
                'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
                'function tokenURI(uint256 tokenId) external view returns (string)',
            ];
            const browserProvider = new ethers.BrowserProvider(provider);
            const contract = new ethers.Contract(contractAddress, abi, browserProvider);
            contract.balanceOf(account).then((balance) => {
                const promises = [];
                for (let i = 0; i < balance; i++) {
                    promises.push(contract.tokenOfOwnerByIndex(account, i));
                }
                Promise.all(promises).then((tokenIds) => {
                    const tokenURIs = tokenIds.map((tokenId) => {
                        return contract.tokenURI(tokenId);
                    });
                    Promise.all(tokenURIs).then((values) => {
                        setCharacters(values);
                    });
                });
            });
        }
    }, [account, provider]);

    const connectWallet = () => {
        metaMask.activate()
    }

    const loadCharacter = (character) => {
        !isMute && playSound('backNextButton');
        setViewMode(ViewMode.APPEARANCE)
    }

    const back = () => {
        setViewMode(ViewMode.LANDING)
        !isMute && playSound('backNextButton');
    }

    return (
        <div className={styles.container}>
        {/* if the user has not logged in, display a message */}
            {!account && (
                <div className={styles.message}>
                    Please connect your wallet to load your characters
                    {/* show connect button */}
                    <button className={styles.button} onClick={() => connectWallet()}>Connect</button>
                </div>
            )}
            <div className={styles.characterContainer}>
                <div className={styles.title}>Load Character</div>
                {characters.map((character, i) => {
                    return (
                        <div
                            key={i}
                                className={styles.character}
                                    onClick={()=> {loadCharacter(character)}}
                                    >
                            {JSON.stringify(character)}
                        </div>
                    );
                })}
            </div>
                {/* show back button to return to landing page */}
            <button className={styles.button} onClick={() => back()}>Back</button>
        </div>
    );
}

export default Load;