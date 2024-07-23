/* ---------- SES IMPORTS ----------- */
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import axios from 'axios';
/*----- EXTERNAL PODS IMPORTS -----*/
import { randomUUID } from 'crypto';

/* ---------- COGNITO IMPORTS ----------- */
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDeleteUserCommand, AdminGetUserCommand, InitiateAuthCommand, AdminDisableUserCommand, AdminEnableUserCommand } from "@aws-sdk/client-cognito-identity-provider";
const cognito_client = new CognitoIdentityProviderClient({ apiVersion: "2016-04-18" });

/* ---------- DYNAMO DB IMPORTS ----------- */
import ddb from "@aws-sdk/lib-dynamodb";
import * as dynamodb from "@aws-sdk/client-dynamodb";
const docClient = new dynamodb.DynamoDBClient();
const ddbDocClient = ddb.DynamoDBDocumentClient.from(docClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});
const { unmarshall, marshall } = await import("@aws-sdk/util-dynamodb");

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3_client = new S3Client({ region: "ap-south-1" });

/* ---------- COGNITO API'S ----------- */
async function create_cognito_user(event) {
  try {
    console.log("Check Event!!!!!!!!!!!", JSON.stringify(event));
    const input = {
      UserPoolId: process.env.USER_POOL_ID,
      Username: event.user_email_id,
      UserAttributes: [{
          Name: "email",
          Value: event.user_email_id,
        },
        {
          Name: "email_verified",
          Value: "true",
        }
      ],
      TemporaryPassword: process.env.temp_pass,
      ForceAliasCreation: true,
      MessageAction: "SUPPRESS",
    };
    const command = new AdminCreateUserCommand(input);
    const response = await cognito_client.send(command);
    const setPasswordInput = {
      UserPoolId: process.env.USER_POOL_ID,
      Username: input.Username,
      Password: process.env.temp_pass,
      Permanent: true,
    };
    const setPasswordCommand = new AdminSetUserPasswordCommand(setPasswordInput);
    await cognito_client.send(setPasswordCommand);
    return response;
  }
  catch (error) {
    throw new Error(error);
  }
}

async function delete_cognito_user(event) {
  let params = {
    UserPoolId: process.env.USER_POOL_ID,
    Username: event.user_email_id,
  };
  try {
    let command = new AdminDeleteUserCommand(params);
    await cognito_client.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error("ERROR IN DELETE!!!", err);
  }
}



/* ---------- DYNAMO DB API'S ----------- */
const query_dynamo = async (params) => {
  try {
    let command = new ddb.QueryCommand(params);
    const data = await ddbDocClient.send(command);
    return data;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const scan_dynamo = async (params) => {
  try {
    let command = new ddb.ScanCommand(params);
    const data = await ddbDocClient.send(command);
    return data;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const insert_into_dynamo = async (params) => {
  try {
    let command = new ddb.PutCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const update_dynamo = async (params) => {
  try {
    let command = new ddb.UpdateCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const delete_dynamo = async (params) => {
  try {
    let command = new ddb.DeleteCommand(params);
    await ddbDocClient.send(command);
    return "Success";
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const query_all_dynamo = async (params) => {
  try {
    let data = { Items: [], Count: 0 };
    const query_dynamo = async (table_params) => {
      let command = new ddb.QueryCommand(params);
      let table_data = await ddbDocClient.send(command);
      data.Count += table_data.Count;
      data.Items = data.Items.concat(table_data.Items);
      if (table_data.LastEvaluatedKey != undefined || table_data.LastEvaluatedKey != null) {
        table_params.ExclusiveStartKey = table_data.LastEvaluatedKey;
        return await query_dynamo(table_params);
      }
      else {
        return data;
      }
    };
    return await query_dynamo(params);
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const batch_get_dynamo = async (params, table_name, retryCount = 0) => {
  try {
    let command = new dynamodb.BatchGetItemCommand(params);
    let res = await ddbDocClient.send(command);
    if (res.UnprocessedItems && res.UnprocessedItems.length > 0) {
      console.log(`$ { res.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error("UnprocessedItems", res.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_get_dynamo(res.UnprocessedItems, retryCount + 1);
    }
    let response_array = res.Responses[table_name];
    let response = {
      Items: [],
      Count: 0,
    };
    response_array.map((item) => {
      response.Items.push(unmarshall(item));
      response.Count++;
      return item;
    });
    return response;
  }
  catch (err) {
    console.log(params, err);
    throw new Error(err);
  }
};

const batch_delete_dynamo = async (params, retryCount = 0) => {
  try {
    let command = new dynamodb.BatchWriteCommand(params);
    let response = await ddbDocClient.send(command);
    console.log("response", response);
    if (response.UnprocessedItems && response.UnprocessedItems.length > 0) {
      console.log(`$ { response.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error(response.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_delete_dynamo(response.UnprocessedItems, retryCount + 1);
    }
    return "Success";
  }
  catch (err) {
    console.log(JSON.stringify(params), err);
    throw new Error(err);
  }
};

const batch_insert_dynamo = async (params, retryCount = 0) => {
  try {
    let command = new ddb.BatchWriteCommand(params);
    let response = await ddbDocClient.send(command);
    console.log("response", response);
    if (response.UnprocessedItems && response.UnprocessedItems.length > 0) {
      console.log(`$ { response.UnprocessedItems.length } unprocessed item(s) left, retrying...`);
      if (retryCount > 2) {
        throw new Error(response.UnprocessedItems);
      }
      await wait(2 ** retryCount * 10);
      return batch_insert_dynamo(response.UnprocessedItems, retryCount + 1);
    }
    return "Success";
  }
  catch (err) {
    console.log(JSON.stringify(params), err);
    throw new Error(err);
  }
};

import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
}
from "@google/generative-ai";

const MODEL_NAME = "gemini-pro";
const API_KEY = "AIzaSyAMD3qVGqpKBp4pUiP_Dm17_2bYnM4DmjY";


async function bardAssistantModelMethod(event) {
  const genAI = new GoogleGenerativeAI(API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  const generationConfig = {
    temperature: 0.7,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
  };

  const safetySettings = [{
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
    },
  ];
  const parts = [{ text: `Give me a prompt to generate a stable diffusion image related to ${event.dynamic_keyword}..Strictly not more than ${event.dynamic_characters} characters..Please dont repeat any prompt used in past!!` }];
  const result = await model.generateContent({
    contents: [{ role: "user", parts }],
    generationConfig,
    safetySettings,
  });
  const response = result.response;
  return response.candidates[0].content.parts[0].text
}

/* ---------- UTILITY'S ----------- */
const check_empty_fields = (event) => {
  let checkEmptyFields = true;
  for (const field in event) {
    if (typeof event[field] == "string") {
      if (event[field].trim().length == 0) {
        checkEmptyFields = false;
      }
      else {
        event[field] = event[field].trim();
      }
    }
  }
  return checkEmptyFields;
};


/* ---------- USER MANAGEMENT ----------- */

async function check_if_bms_user_exists(event) {
  let checkUserExistsParams = {
    TableName: "your_table_name",
    KeyConditionExpression: "user_id = :user_id",
    FilterExpression: "user_status = :user_status",
    ExpressionAttributeValues: {
      ":user_id": event.cognito_email.username,
      ":user_status": "ACTIVE",
    },
  };
  let user = await query_dynamo(checkUserExistsParams);
  return user;
}

async function get_current_user_details(event) {
  if (check_empty_fields(event)) {
    let getUserDetailsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };
    let user = await query_dynamo(getUserDetailsParams);
    if (user.Count > 0) {
      let response = {};
      delete user.Items[0].user_id;
      response.items = user.Items;
      return { status: "Success", data: response };
    }
    else {
      throw new Error(`User  not found`);
    }
  }
  else {
    throw new Error("Empty fields occured");
  }
}

async function create_user(event) {
  if (check_empty_fields(event)) {
    let checkIfCreatorExistParams = {
      TableName: 'your_table_name',
      KeyConditionExpression: 'user_id = :user_id',
      ExpressionAttributeValues: {
        ':user_id': event.cognito_email.username
      }
    };
    let creator_user = await query_dynamo(checkIfCreatorExistParams);
    if (creator_user.Items.length > 0) {
      let checkIfUserExistParams = {
        TableName: 'your_table_name',
        IndexName: 'user_email_id-index',
        KeyConditionExpression: 'user_email_id = :user_email_id',
        ExpressionAttributeValues: {
          ':user_email_id': event.user_email_id.toLowerCase().trim()
        }
      };
      let user = await query_dynamo(checkIfUserExistParams);
      if (user.Items.length == 0) {
        let cognito_user = await create_cognito_user(event);
        console.log("Check cognito_user name", cognito_user);
        let createUserParams = {
          TableName: "your_table_name",
          Item: {
            user_id: cognito_user.User.Username,
            user_name: event.user_name,
            user_email_id: event.user_email_id,
            user_created_on: new Date().getTime(),
            user_status: "ACTIVE"
          }
        };
        await insert_into_dynamo(createUserParams);
        return {
          status: 'SUCCESS',
          status_message: 'User created and Invited successfully!!'
        };
      }
      else {
        throw new Error("User With Email ID Already Exists!!")
      }
    }
    else {
      throw new Error('Creator Does Not Exists!!');
    }
  }
  else {
    throw new Error('Empty fields occured cannot create user!!');
  }
}

async function list_users(event) {
  if (check_empty_fields(event)) {
    let checkUserExistsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };
    let user = await query_dynamo(checkUserExistsParams);
    if (user.Count > 0) {
      let listUserParams = {
        TableName: "your_table_name",
      };
      if (event.next_token) {
        listUserParams.ExclusiveStartKey = JSON.parse(Buffer.from(event.next_token.trim(), "base64").toString("ascii"));
      }
      if (event.user_status != "ALL" && event.user_status) {
        listUserParams.FilterExpression = "user_status = :user_status";
        listUserParams.ExpressionAttributeValues = {
          ":user_status": event.user_status,
        };
      }
      let users = await scan_dynamo(listUserParams);
      if (users.Count > 0) {
        let response = {};
        response.items = users.Items.sort((a, b) => b.user_created_on - a.user_created_on);
        if (users.LastEvaluatedKey) {
          response.next_token = Buffer.from(JSON.stringify(users.LastEvaluatedKey)).toString("base64");
        }
        return { status: "Success", data: response };
      }
      else {
        throw new Error("No users to list");
      }
    }
    else {
      throw new Error(`User with email ${event.user_email_id} not exist`);
    }
  }
  else {
    throw new Error("Empty field occured cannot list user");
  }
}

async function edit_user(event) {
  if (check_empty_fields(event)) {
    let checkUpdaterExistParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };
    let updater = await query_dynamo(checkUpdaterExistParams);
    if (updater.Count > 0) {
      let checkIfUserExistParams = {
        TableName: "your_table_name",
        IndexName: "user_email_id-index",
        KeyConditionExpression: "user_email_id = :user_email_id",
        ExpressionAttributeValues: {
          ":user_email_id": event.user_email_id,
        },
      };
      let user = await query_dynamo(checkIfUserExistParams);
      if (user.Count > 0) {
        if (event.action == "UPDATE") {
          let UpdateExpression = "SET ";
          let ExpressionAttributeValues = {};
          let ExpressionAttributeNames = {};

          for (const field in event) {
            if (field === "user_status") {
              if (event.user_status !== user.Items[0].user_status) {
                UpdateExpression += `#${field} = :${field},`;
                ExpressionAttributeValues[":" + field] = event[field];
                ExpressionAttributeNames["#" + field] = field;
              }
              else {
                throw new Error(`User already in ${event.user_status} status`);
              }
            }
            else {
              UpdateExpression += `#${field} = :${field},`;
              ExpressionAttributeValues[":" + field] = event[field];
              ExpressionAttributeNames["#" + field] = field;
            }
          }

          UpdateExpression = UpdateExpression.slice(0, -1);

          let updateParams = {
            TableName: "your_table_name",
            Key: {
              user_id: user.Items[0].user_id,
            },
            UpdateExpression: UpdateExpression,
            ExpressionAttributeValues: ExpressionAttributeValues,
            ExpressionAttributeNames: ExpressionAttributeNames,
            ReturnValues: "UPDATED_NEW",
          };

          await update_dynamo(updateParams);
          return {
            status: "SUCCESS",
            status_message: "Updated successfully!!",
          };
        }

        if (event.action == "DELETE") {
          await delete_cognito_user(event);
          let deleteUserParams = {
            TableName: "your_table_name",
            Key: {
              user_id: user.Items[0].user_id,
            },
          };
          await delete_dynamo(deleteUserParams);
          return {
            status: "SUCCESS",
            status_message: "User deleted successfully!!",
          };
        }
        else {
          throw new Error("Action Required!!");
        }
      }
      else {
        throw new Error(`User with ID ${event.user_email_id} not found`);
      }
    }
    else {
      throw new Error(`Updater with ID ${event.updater_email_id} not found`);
    }
  }
  else {
    throw new Error("Empty fields occurred; cannot update user");
  }
}

async function create_category(event) {
  console.log("EVENT", event)
  if (check_empty_fields(event)) {
    let checkIfCreatorExistParams = {
      TableName: 'your_table_name',
      KeyConditionExpression: 'user_id = :user_id',
      ExpressionAttributeValues: {
        ':user_id': event.cognito_email.username
      }
    };
    let creator_user = await query_dynamo(checkIfCreatorExistParams);
    if (creator_user.Items.length > 0) {
      let checkIfCatagoryExistParams = {
        TableName: 'your_table_name',
        IndexName: 'category_name-index',
        KeyConditionExpression: 'category_name = :category_name',
        ExpressionAttributeValues: {
          ':category_name': event.category_name.toLowerCase().trim()
        }
      };
      let category = await query_dynamo(checkIfCatagoryExistParams);
      if (category.Items.length == 0) {
        let createCategoryParams = {
          TableName: "your_table_name",
          Item: {
            category_id: randomUUID(),
            category_name: event.category_name.toLowerCase(),
            category_created_on: new Date().getTime(),
            category_icon: event.category_icon,
            category_status: "UNTAGGED"
          }
        };
        await insert_into_dynamo(createCategoryParams);
        return {
          status: 'SUCCESS',
          status_message: 'Category Created Successfully!!'
        };
      }
      else {
        throw new Error("User With Email ID Already Exists!!")
      }
    }
    else {
      throw new Error('Creator Does Not Exists!!');
    }
  }
  else {
    throw new Error('Empty fields occured cannot create user!!');
  }
}

async function list_categories(event) {
  if (check_empty_fields(event)) {
    let checkUserExistsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };
    let user = await query_dynamo(checkUserExistsParams);
    if (user.Count > 0) {
      let listUserParams = {
        TableName: "your_table_name",
      };
      if (event.next_token) {
        listUserParams.ExclusiveStartKey = JSON.parse(Buffer.from(event.next_token.trim(), "base64").toString("ascii"));
      }
      if (event.category_status != "ALL" && event.category_status) {
        listUserParams.FilterExpression = "category_status = :category_status";
        listUserParams.ExpressionAttributeValues = {
          ":category_status": event.category_status,
        };
      }
      let category = await scan_dynamo(listUserParams);
      if (category.Count > 0) {
        let response = {};
        response.items = category.Items.sort((a, b) => b.category_created_on - a.category_created_on);
        if (category.LastEvaluatedKey) {
          response.next_token = Buffer.from(JSON.stringify(category.LastEvaluatedKey)).toString("base64");
        }
        return { status: "Success", data: response };
      }
      else {
        throw new Error("No users to list");
      }
    }
    else {
      throw new Error("User Does Not Exist!!")
    }
  }
  else {
    throw new Error("Empty field occured cannot list user");
  }
}

async function edit_category(event) {
  console.log("Edit--------------->", event);

  if (check_empty_fields(event)) {
    let checkUpdaterExistParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };

    let updater = await query_dynamo(checkUpdaterExistParams);
    console.log("updater", updater);

    if (updater.Count > 0) {
      let checkIfCategoryExistParams = {
        TableName: "your_table_name",
        KeyConditionExpression: "category_id = :category_id",
        ExpressionAttributeValues: {
          ":category_id": event.category_id,
        },
      };

      let category = await query_dynamo(checkIfCategoryExistParams);

      if (category.Count > 0) {
        if (event.admin_action == "UPDATE") {
          let UpdateExpression = "SET ";
          let ExpressionAttributeValues = {};

          for (const field in event) {
            if (field == 'category_name' || field == 'category_icon') {
              UpdateExpression += `${field} = :${field},`;
              ExpressionAttributeValues[":" + field] = event[field];
            }
          }

          UpdateExpression = UpdateExpression.slice(0, -1);

          let updateParams = {
            TableName: "your_table_name",
            Key: {
              category_id: category.Items[0].category_id,
            },
            UpdateExpression: UpdateExpression,
            ExpressionAttributeValues: ExpressionAttributeValues,
            ReturnValues: "UPDATED_NEW",
          };

          await update_dynamo(updateParams);

          return {
            status: "SUCCESS",
            status_message: "Category Details Updated Successfully!!",
          };
        }

        if (event.admin_action == "DELETE") {
          let deleteUserParams = {
            TableName: "your_table_name",
            Key: {
              category_id: category.Items[0].category_id,
            },
          };

          await delete_dynamo(deleteUserParams);

          return {
            status: "SUCCESS",
            status_message: "Category deleted successfully!!",
          };
        }
        else {
          throw new Error("Action Required!!");
        }
      }
      else {
        throw new Error("Category Not Found!!");
      }
    }
    else {
      throw new Error(`Updater with ID ${event.updater_email_id} not found`);
    }
  }
  else {
    throw new Error("Empty fields occurred, cannot update user");
  }
}

async function generateRandomCode() {
  const length = 4;
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    code += characters.charAt(randomIndex);
  }


  let checkIfQRCodeExistParams = {
    TableName: 'your_table_name',
    KeyConditionExpression: 'qrID = :qrID',
    ExpressionAttributeValues: {
      ':qrID': code
    }
  };
  let qrcode = await query_dynamo(checkIfQRCodeExistParams);
  if (qrcode.Count == 0) {
    return code;
  }
  else {
    await generateRandomCode();
  }

}

async function get_qr_generation_prompts(offset, quantity) {
  try {
    const response = await axios.get(`https://datasets-server.huggingface.co/rows?dataset=Gustavosta%2FStable-Diffusion-Prompts&config=default&split=train&offset=${offset}&length=${quantity}`);
    console.log('API response:', response.data);
    return response.data;
  }
  catch (error) {
    console.error('There has been a problem with your axios operation:', error);
    return null; // Return null or handle this case as required
  }
}

async function create_qr_code(event) {
  console.log("EVENT------->", event);
  const qr_quantity = 100;

  // if (qr_quantity > 100) {
  //   throw new Error("You Can Generate A Maximum Of 100 QR Codes At Once!!");
  // }
  const { offset, quantity } = event;
  const qr_prompts = await get_qr_generation_prompts(offset, quantity);

  if (qr_prompts === null || !qr_prompts.rows) {
    throw new Error("Failed to fetch sufficient QR generation prompts");
  }

  let qr_ids = [];

  for (let i = 0; i < quantity; i++) {
    let qrID = await generateRandomCode();
    let qr_prompt = qr_prompts.rows[i].row.Prompt;

    let createCategoryParams = {
      TableName: "your_table_name",
      Item: {
        qrID: qrID,
        qr_code_created_on: new Date().getTime(),
        status: "UNTAGGED",
        qr_code_category: "NOT_CATEGORIZED",
        qr_prompt: qr_prompt
      }
    };

    await insert_into_dynamo(createCategoryParams);
    qr_ids.push({ ...createCategoryParams.Item });
  }

  return {
    status: 'SUCCESS',
    qr_ids: qr_ids,
    status_message: 'QR Code Generated Successfully!!'
  };
}

async function edit_qr_code(event) {
  if (check_empty_fields(event)) {
    let checkIfCategoryExistParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "qrID = :qrID",

      ExpressionAttributeValues: {
        ":qrID": event.qrID,
      },
    };
    let qrcode = await query_dynamo(checkIfCategoryExistParams);
    if (qrcode.Count > 0) {
      if (event.action == "UPDATE") {
        let UpdateExpression = "SET ";
        let ExpressionAttributeValues = {};
        let editableFields = ["status", "qr_code_image_url_key", "qr_code_category"];

        let qr_code_details = { ...qrcode.Items[0] };

        if (qr_code_details.status == 'UNTAGGED' && !qr_code_details.qr_code_image_url_key) {
          event.status = "PENDING_APPROVAL";
        }

        for (const field in event) {
          if (editableFields.includes(field)) {
            UpdateExpression += `${field} = :${field},`;
            ExpressionAttributeValues[":" + field] = event[field];
          }
        }
        UpdateExpression = UpdateExpression.slice(0, -1);
        let updateParams = {
          TableName: "your_table_name",
          Key: {
            qrID: qrcode.Items[0].qrID,
          },
          UpdateExpression: UpdateExpression,
          ExpressionAttributeValues: ExpressionAttributeValues,
          ReturnValues: "UPDATED_NEW",
        };
        await update_dynamo(updateParams);
        return {
          status: "SUCCESS",
          status_message: "QR Details Updated Successfully!!",
        };
      }
      else if (event.action == "DELETE") {
        let deleteUserParams = {
          TableName: "your_table_name",
          Key: {
            qrID: qrcode.Items[0].qrID,
          },
        };
        await delete_dynamo(deleteUserParams);
        return {
          status: "SUCCESS",
          status_message: "QR Code deleted successfully!!",
        };
      }
      else {
        throw new Error("Action Required!!");
      }

    }
    else {
      throw new Error("QR Code Does Not Exists!!");
    }
  }
  else {
    throw new Error("Empty Fields Occured!!");
  }
}

async function list_qr_codes(event) {
  if (check_empty_fields(event)) {
    let checkUserExistsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "user_id = :user_id",
      FilterExpression: "user_status = :user_status",
      ExpressionAttributeValues: {
        ":user_id": event.cognito_email.username,
        ":user_status": "ACTIVE",
      },
    };
    let user = await query_dynamo(checkUserExistsParams);
    if (user.Count > 0) {
      let listUserParams = {
        TableName: "your_table_name",
      };
      if (event.next_token) {
        listUserParams.ExclusiveStartKey = JSON.parse(Buffer.from(event.next_token.trim(), "base64").toString("ascii"));
      }
      if (event.category_status != "ALL" && event.status) {
        listUserParams.FilterExpression = "status = :status";
        listUserParams.ExpressionAttributeValues = {
          ":status": event.status,
        };
      }
      let qrcodes = await scan_dynamo(listUserParams);
      if (qrcodes.Count > 0) {
        let response = {};
        response.items = qrcodes.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on);
        if (qrcodes.LastEvaluatedKey) {
          response.next_token = Buffer.from(JSON.stringify(qrcodes.LastEvaluatedKey)).toString("base64");
        }
        return { status: "Success", data: response };
      }
      else {
        throw new Error("No QR Codes to list");
      }
    }
    else {
      throw new Error("User Does Not Exists!!")
    }
  }
  else {
    throw new Error("Empty field occured cannot list user");
  }
}

async function qr_code_details(event) {
  let checkIfQRCodeExistParams = {
    TableName: "your_table_name",
    KeyConditionExpression: "qrID = :qrID",

    ExpressionAttributeValues: {
      ":qrID": event.qrID,
    },
  };
  let qrcode = await query_dynamo(checkIfQRCodeExistParams);
  if (qrcode.Count > 0) {
    return {
      status: "SUCCESS",
      data: qrcode.Items[0]
    }
  }
  else {
    throw new Error("QR Code Does Not Exists!!")
  }
}

async function generating_s3_upload_url(event) {
  let params = {
    Bucket: "qrjungle-all-qrcodes",
    Key: event.key
  };
  const command = new PutObjectCommand(params);
  try {
    const presignedUrl = await getSignedUrl(s3_client, command, { expiresIn: 36000 });
    console.log("Check presignedUrl", presignedUrl);
    return {
      status: "Success",
      url: presignedUrl
    };
  }
  catch (error) {
    console.error("Error generating presigned URL:", error);
    throw error;
  }
};

async function get_presigned_url(event) {
  console.log("EVENT------>", event)
  try {
    const s3Params = {
      Bucket: "qrjungle-all-qrcodes",
      Key: event.key,
      Expires: 36000
    };
    const getSignedUrlCommand = new GetObjectCommand(s3Params);
    const s3_presigned_url = await getSignedUrl(s3_client, getSignedUrlCommand, { expiresIn: 36000 });
    console.log("Presigned---->", s3_presigned_url)
    return {
      status: "Success",
      url: s3_presigned_url
    };
  }
  catch (error) {
    console.error("Error generating presigned URL:", error);
    throw error;
  }
};

async function list_all_qr_for_bms(event) {
  console.log("event", event);
  const input = {
    TableName: "your_table_name",
    // FilterExpression: "status <> :purchased",
    // ExpressionAttributeValues: {
    //   ":purchased": "PURCHASED",
    //   // ":pending_approval": "PENDING_APPROVAL"
    // },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    let result = await scan_dynamo(input);
    let response = {}
    response.items = result.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on)
    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return {
      status: 200,
      data: response,
      nextToken: nextToken
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}

async function list_all_qr_for_portal(event) {
  console.log("event", event);

  const input = {
    TableName: "your_table_name",
    FilterExpression: "status <> :purchased AND status <> :pending_approval AND status <> :untagged",
    ExpressionAttributeValues: {
      ":purchased": "PURCHASED",
      ":pending_approval": "PENDING_APPROVAL",
      ":untagged": "UNTAGGED"
    },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    const result = await scan_dynamo(input);

    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    const desiredFields = ["price"];

    const items = (result.Items || []).map(item => {
      desiredFields.forEach(field => {
        if (!(field in item)) {
          item[field] = null;
        }
      });
      return item;
    });

    return {
      status: 200,
      data: items,
      nextToken: nextToken,
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}

async function approve_or_reject(event) {
  console.log("Event->", event)
  const userexists = await check_if_bms_user_exists(event);
  if (userexists.Count > 0) {
    if (event.status === "APPROVE") {
      const updateStatusParams = {
        TableName: "your_table_name",
        Key: {
          "qrID": event.qrID
        },
        UpdateExpression: "SET qr_code_category= :qr_code_category , status= :status, price= :price",
        ExpressionAttributeValues: {
          ":qr_code_category": event.qr_code_category_name.toLowerCase(),
          ":price": event.price,
          ":status": "APPROVED"
        }
      }
      const res = await update_dynamo(updateStatusParams);
      // console.log("RES------------->".res)
      if (res == "Success") {
        const getCategoryIdParams = {
          TableName: "your_table_name",
          IndexName: "category_name-index",
          KeyConditionExpression: "category_name= :category_name",
          ExpressionAttributeValues: {
            ":category_name": event.qr_code_category_name.toLowerCase()
          }
        }
        const details = await query_dynamo(getCategoryIdParams);
        // console.log("------------->", details)
        if (details.Items[0].category_status == "UNTAGGED") {
          const updateParams = {
            TableName: "your_table_name",
            Key: {
              "category_id": details.Items[0].category_id
            },
            UpdateExpression: "SET category_status= :category_status",
            ExpressionAttributeValues: {
              ":category_status": "ACTIVE"
            }
          }
          await update_dynamo(updateParams);
        }
      }
      return { status: 200, status_message: "Approval successful!" };

    }
    else if (event.status === "REJECT") {
      const deleteParams = {
        TableName: "your_table_name",
        Key: {
          "qrID": event.qrID
        }
      }
      await delete_dynamo(deleteParams);
      return { status: 200, status_message: "Rejected and deleted successfully!" }
    }
  }
  else {
    throw new Error("User does not exist!");
  }
}

async function approve_or_reject_private_qrs(event) {
  console.log("Event->", event);
  const userexists = await check_if_bms_user_exists(event);

  if (userexists.Count > 0) {
    if (event.status === "APPROVE") {
      if (event.qr_code_category_name.startsWith("_")) {
        const updateStatusParams = {
          TableName: "your_table_name",
          Key: {
            "qrID": event.qrID
          },
          UpdateExpression: "SET qr_code_category = :qr_code_category, status = :status, price = :price",
          ExpressionAttributeValues: {
            ":qr_code_category": event.qr_code_category_name,
            ":price": event.price,
            ":status": "APPROVED"
          }
        };
        await update_dynamo(updateStatusParams);
        return { status: 200, status_message: "Approved successfully!" };
      }
      else {
        return { status: 400, status_message: "Forbidden! You're trying to add it to a public category!" };
      }
    }
    else if (event.status === "REJECT") {
      const deleteParams = {
        TableName: "your_table_name",
        Key: {
          "qrID": event.qrID
        }
      };
      await delete_dynamo(deleteParams);
      return { status: 200, status_message: "Rejected and deleted successfully!" };
    }
    else {
      return { status: 400, status_message: "Invalid QR code status!" };
    }
  }
  else {
    return { status: 404, status_message: "User not found!" };
  }
}

async function delete_bms_user(event) {
  const checkUserExists = {
    TableName: "your_table_name",
    KeyConditionExpression: "user_id= :user_id",
    ExpressionAttributeValues: {
      ":user_id": event.user_id
    }
  }
  const userDetails = await query_dynamo(checkUserExists);
  if (userDetails.Count > 0) {
    await delete_cognito_user(event);
    const deleteParams = {
      TableName: "your_table_name",
      Key: {
        "user_id": userDetails.Items[0].user_id
      }
    }
    await delete_dynamo(deleteParams);
    return { status: 200, status_message: "Deleted successfully!" };

  }
  else throw new Error("User does not exist!");
}

async function edit_qr_category(event) {
  const userExists = await check_if_bms_user_exists(event);
  if (userExists.Count > 0) {
    const checkCategoryExistsParams = {
      TableName: "your_table_name",
      KeyConditionExpression: "category_id= :category_id",
      ExpressionAttributeValues: {
        ":category_id": event.category_id
      }
    }
    const category = await query_dynamo(checkCategoryExistsParams);
    if (checkCategoryExistsParams.Count > 0) {
      let UpdateExpression = "SET ";
      let ExpressionAttributeValues = {};
      for (const field in event) {
        UpdateExpression += `${field} = :${field},`;
        ExpressionAttributeValues[":" + field] = event[field];
      }
      UpdateExpression = UpdateExpression.slice(0, -1);
      let updateParams = {
        TableName: "your_table_name",
        Key: {
          category_id: category.Items[0].category_id,
        },
        UpdateExpression: UpdateExpression,
        ExpressionAttributeValues: ExpressionAttributeValues,
        ReturnValues: "UPDATED_NEW",
      };
      await update_dynamo(updateParams);
      return {
        status: "SUCCESS",
        status_message: "Category Details Updated Successfully!!",
      };
    }
  }
  else throw new Error("User does not exist!")
}

async function list_qr_by_category(event) {
  const input = {
    TableName: "your_table_name",
    IndexName: "qr_code_category-index",
    KeyConditionExpression: "qr_code_category = :qr_code_category",
    FilterExpression: "status = :approved",
    ExpressionAttributeValues: {
      ":qr_code_category": event.qr_code_category_name,
      ":approved": "APPROVED",
      // ":purchased": "PURCHASED"
    }
  };

  const result = await query_dynamo(input);
  return { status: 200, data: result.Items };
}

async function list_active_categories(event) {
  const input = {
    TableName: "your_table_name",
    FilterExpression: "category_status= :category_status",
    ExpressionAttributeValues: {
      ":category_status": "ACTIVE"
    },
    Limit: 100
  }
  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }
  try {
    const result = await scan_dynamo(input);

    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }
    return {
      status: 200,
      data: result.Items,
      nextToken: nextToken,
      // totalCount: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}

/********************PRIVATE CATEGORY MANAGEMENT**********************/

async function create_private_category(event) {
  console.log("PRIV----->", event);
  const adminDetails = await check_if_bms_user_exists(event);
  if (adminDetails.Count > 0) {
    const checkIfCategoryExistsParams = {
      TableName: "your_table_name",
      IndexName: "category_name-index",
      KeyConditionExpression: "category_name= :category_name",
      ExpressionAttributeValues: {
        ":category_name": "_" + event.category_name.toLowerCase() + "_"
      }
    }
    const checkDetails = await query_dynamo(checkIfCategoryExistsParams);
    if (checkDetails.Count > 0) {
      return { status: 400, status_message: "Category name already exists!" }
    }

    const creationParams = {
      TableName: "your_table_name",
      Item: {
        category_id: randomUUID(),
        category_name: "_" + event.category_name.toLowerCase() + "_",
        category_icon: event.category_icon,
        visible_to: [],
        created_on: Date.now(),
        category_status: "ACTIVE",
        created_by: adminDetails.Items[0].user_email_id
      }
    }
    await insert_into_dynamo(creationParams);
    return { status: 200, status_message: "Private category created successfully!" }
  }
  else {
    return { status: 401, status_message: "Unauthorized exception!" }
  }
}

async function add_viewer(event) {
  console.log("ADDVIEWER----->", event);
  const checkCategoryExistsParams = {
    TableName: "your_table_name",
    KeyConditionExpression: "category_id= :category_id",
    ExpressionAttributeValues: {
      ":category_id": event.category_id
    }
  }
  const details = await query_dynamo(checkCategoryExistsParams);
  if (details.Count > 0) {
    const { user_email_id } = event;
    const addViewerParams = {
      TableName: "your_table_name",
      Key: {
        category_id: details.Items[0].category_id
      },
      UpdateExpression: "SET visible_to = list_append(visible_to, :visible_to)",
      ExpressionAttributeValues: {
        ":visible_to": [user_email_id.toLowerCase()]
      }
    }
    const res = await update_dynamo(addViewerParams);
    if (res === 'Success') {
      const insertParams = {
        TableName: "your_table_name",
        Item: {
          visible_id: randomUUID(),
          user_email_id: user_email_id,
          added_on: Date.now(),
          category_id: details.Items[0].category_id,
          category_icon: details.Items[0].category_icon,
          category_name: details.Items[0].category_name
        }
      }
      await insert_into_dynamo(insertParams);
    }
    console.log("RES----->", res);
    return { status: 200, status_message: "Added viewer successfully!" }
  }
  else {
    return { status: 404, status_message: "Category not found!" }
  }
}


async function list_private_categories(event) {
  const input = {
    TableName: "your_table_name",
    Limit: 50
  }
  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }
  try {
    const result = await scan_dynamo(input);

    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }
    return {
      status: 200,
      data: result.Items,
      nextToken: nextToken,
      // totalCount: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}

/****************************BMS QUERIES********************************/

async function list_approved_qrs(event) {
  const input = {
    TableName: "your_table_name",
    IndexName: "status-index",
    KeyConditionExpression: "status= :status",
    ExpressionAttributeValues: {
      ":status": "APPROVED"
    },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    let result = await query_dynamo(input);
    let response = {}
    response.items = result.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on)
    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return {
      status: 200,
      data: response,
      nextToken: nextToken,
      count: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}


async function list_purchased_qrs(event) {
  const input = {
    TableName: "your_table_name",
    IndexName: "status-index",
    KeyConditionExpression: "status= :status",
    ExpressionAttributeValues: {
      ":status": "PURCHASED"
    },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    let result = await query_dynamo(input);
    let response = {}
    response.items = result.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on)
    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return {
      status: 200,
      data: response,
      nextToken: nextToken,
      count: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}


async function list_pending_approval_qrs(event) {
  const input = {
    TableName: "your_table_name",
    IndexName: "status-index",
    KeyConditionExpression: "status= :status",
    ExpressionAttributeValues: {
      ":status": "PENDING_APPROVAL"
    },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    let result = await query_dynamo(input);
    let response = {}
    response.items = result.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on)
    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return {
      status: 200,
      data: response,
      nextToken: nextToken,
      count: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}

async function list_untagged_qrs(event) {
  const input = {
    TableName: "your_table_name",
    IndexName: "status-index",
    KeyConditionExpression: "status= :status",
    ExpressionAttributeValues: {
      ":status": "UNTAGGED"
    },
    Limit: 50
  };

  if (event.nextToken) {
    input.ExclusiveStartKey = JSON.parse(Buffer.from(event.nextToken, 'base64').toString('ascii'));
  }

  try {
    let result = await query_dynamo(input);
    let response = {}
    response.items = result.Items.sort((a, b) => b.qr_code_created_on - a.qr_code_created_on)
    let nextToken = null;
    if (result.LastEvaluatedKey) {
      nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
    }

    return {
      status: 200,
      data: response,
      nextToken: nextToken,
      count: result.Count
    };
  }
  catch (error) {
    console.error("Error scanning DynamoDB:", error);
    return {
      status: 500,
      status_message: "Internal Server Error"
    };
  }
}



async function add_redeemables_to_user(event) {
  const checkIfUserExistParams = {
    TableName: "your_table_name",
    IndexName: "user_email_id-index",
    KeyConditionExpression: "user_email_id= :user_email_id",
    ExpressionAttributeValues: {
      ":user_email_id": event.user_email_id
    }
  }
  const userDetails = await query_dynamo(checkIfUserExistParams);
  if (userDetails.Count > 0) {
    const addRedeemableCountToUserParams = {
      TableName: "your_table_name",
      Key: {
        "user_id": userDetails.Items[0].user_id
      },
      UpdateExpression: "SET redeem_count= :redeem_count",
      ExpressionAttributeValues: {
        ":redeem_count": event.redeem_count
      }
    }
    await update_dynamo(addRedeemableCountToUserParams);
    return { status: 200, status_message: "Added successfully!" }
  }
  else {
    return { status: 404, status_message: "User not found!" }
  }
}

async function list_custom_requests(event) {
  const input = {
    TableName: "qrjungle_customization_requests",
  }
  const result = await scan_dynamo(input);
  return { status: 200, data: result.Items }
}

export const handler = async (event) => {
  switch (event.command) {
    /* ---------- USER MANAGEMENT ----------- */
    case 'getCurrentUserDetails':
      return await get_current_user_details(event);

    case 'createUser':
      return await create_user(event);

    case 'deleteBMSUser':
      return await delete_bms_user(event);

    case 'editUser':
      return await edit_user(event);

    case 'listUsers':
      return await list_users(event);

    case 'createCategory':
      return await create_category(event);

    case 'editcategory':
      return await edit_category(event);

    case 'listCategories':
      return await list_categories(event);

    case "createQRCode":
      return await create_qr_code(event);

    case 'editQRCode':
      return await edit_qr_code(event);

      // case 'listQrCodes':
      //   return await list_qr_codes(event);

    case 'getQRCodeDetails':
      return await qr_code_details(event);

    case "generatingS3UploadUrl":
      return await generating_s3_upload_url(event);

    case "getPresignedURL":
      return await get_presigned_url(event);

    case "listAllQrs":
      return await list_all_qr_for_bms(event);

    case 'listPortalQrs':
      return list_all_qr_for_portal(event);
      /*******************QR MANAGEMENT*********************/

    case "approveOrReject":
      return await approve_or_reject(event);

    case "approveOrRejectPrivateQrs":
      return await approve_or_reject_private_qrs(event);

    case "editQrCategory":
      return await edit_qr_category(event);

    case "listQrByCategory":
      return await list_qr_by_category(event);

    case "listActiveCategories":
      return await list_active_categories(event);

      /********************PRIVATE CATEGORY MANAGEMENT**********************/

    case 'createPrivateCategory':
      return await create_private_category(event);

    case 'addViewer':
      return await add_viewer(event);

    case 'listPrivateCategories':
      return await list_private_categories(event);

    case 'addRedeemablesToUser':
      return await add_redeemables_to_user(event);

      /****************************BMS QUERIES********************************/


    case 'listApprovedQrs':
      return await list_approved_qrs(event);

    case 'listPurchasedQrs':
      return await list_purchased_qrs(event);

    case 'listPendingApprovalQrs':
      return await list_pending_approval_qrs(event);

    case 'listUntaggedQrs':
      return await list_untagged_qrs(event);

    case 'listCustomRequests':
      return await list_custom_requests(event);

  }
};
