/**
 * Tries to parse the JSON data, and returns undefined if parsing fails.
 * @param jsonString The string to be parsed.
 * @returns The parsed JSON data or undefined if the data is not valid JSON.
 */
export const JSONTryParse = <T>(jsonString: any): T | undefined => {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    return undefined;
  }
};
